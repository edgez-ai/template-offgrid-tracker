#include "halow_pawr.h"

#include <inttypes.h>
#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "edgez_halow_mesh_service.h"
#include "edgez_pawr_bulk_test.h"
#include "edgez_pawr_protocol.h"

#define PAWR_QUEUE_DEPTH 4U

static const char *TAG = "halow_pawr";

struct pawr_action {
    uint8_t source_mac[6];
    int16_t rssi_dbm;
    uint16_t length;
    uint8_t payload[EDGEZ_PAWR_MAX_ACTION_PAYLOAD];
};

static QueueHandle_t action_queue;
static TaskHandle_t worker_task;
static halow_pawr_beacon_callback_t beacon_callback;
static void *beacon_callback_arg;

#if CONFIG_OFFGRID_PAWR_BULK_TEST_RECEIVER
struct pawr_bulk_receive_state {
    bool active;
    bool invalid;
    uint8_t source_mac[6];
    uint8_t test_index;
    uint32_t session_id;
    uint32_t total_length;
    uint32_t expected_digest;
    uint32_t digest;
    uint32_t received;
    uint16_t unique_chunks;
    uint16_t frames_received;
    uint32_t received_map[8];
    bool saw_last;
    int64_t started_us;
};

static struct pawr_bulk_receive_state bulk_state;

static bool pawr_bulk_test_receive(const uint8_t source_mac[6],
                                   const uint8_t *payload,
                                   size_t payload_len)
{
    struct edgez_pawr_bulk_chunk chunk;

    if (!edgez_pawr_bulk_decode(payload, payload_len, &chunk)) {
        return false;
    }

    const bool first = (chunk.flags & EDGEZ_PAWR_BULK_FLAG_FIRST) != 0U;
    if (first && (!bulk_state.active ||
                  bulk_state.session_id != chunk.session_id ||
                  bulk_state.test_index != chunk.test_index)) {
        memset(&bulk_state, 0, sizeof(bulk_state));
        bulk_state.active = true;
        memcpy(bulk_state.source_mac, source_mac, sizeof(bulk_state.source_mac));
        bulk_state.test_index = chunk.test_index;
        bulk_state.session_id = chunk.session_id;
        bulk_state.total_length = chunk.total_length;
        bulk_state.expected_digest = chunk.expected_digest;
        bulk_state.digest = edgez_pawr_bulk_expected_digest(
            chunk.test_index, chunk.total_length);
        bulk_state.started_us = esp_timer_get_time();
    }

    if (!bulk_state.active ||
        memcmp(bulk_state.source_mac, source_mac, sizeof(bulk_state.source_mac)) != 0 ||
        bulk_state.session_id != chunk.session_id ||
        bulk_state.test_index != chunk.test_index ||
        bulk_state.total_length != chunk.total_length ||
        bulk_state.expected_digest != chunk.expected_digest) {
        return true;
    }

    bulk_state.frames_received++;
    if (chunk.chunk_index >= 256U) {
        bulk_state.invalid = true;
        return true;
    }
    const uint32_t bit = UINT32_C(1) << (chunk.chunk_index % 32U);
    uint32_t *word = &bulk_state.received_map[chunk.chunk_index / 32U];
    if ((*word & bit) == 0U) {
        for (uint16_t i = 0; i < chunk.data_length; ++i) {
            if (chunk.data[i] != edgez_pawr_bulk_test_byte(
                                     chunk.test_index, chunk.offset + i)) {
                bulk_state.invalid = true;
                break;
            }
        }
        *word |= bit;
        bulk_state.received += chunk.data_length;
        bulk_state.unique_chunks++;
    }

    bulk_state.saw_last |=
        (chunk.flags & EDGEZ_PAWR_BULK_FLAG_LAST) != 0U;
    if (bulk_state.saw_last && bulk_state.received >= bulk_state.total_length) {
        const bool passed = !bulk_state.invalid &&
            bulk_state.received == bulk_state.total_length &&
            bulk_state.digest == bulk_state.expected_digest;
        const uint32_t elapsed_ms = (uint32_t)(
            (esp_timer_get_time() - bulk_state.started_us) / 1000);

        ESP_LOGI(TAG,
                 "PAWR_BULK_TEST %s test=%u bytes=%" PRIu32
                 " chunks=%u frames=%u elapsed_ms=%" PRIu32
                 " digest=%08" PRIx32
                 " source=%02x:%02x:%02x:%02x:%02x:%02x",
                 passed ? "PASS" : "FAIL", (unsigned)bulk_state.test_index,
                 bulk_state.received, (unsigned)bulk_state.unique_chunks,
                 (unsigned)bulk_state.frames_received, elapsed_ms,
                 bulk_state.digest, source_mac[0], source_mac[1],
                 source_mac[2], source_mac[3], source_mac[4], source_mac[5]);
        bulk_state.active = false;
    }
    return true;
}
#endif

static void pawr_worker(void *arg)
{
    (void)arg;
    struct pawr_action action;
    while (true) {
        if (xQueueReceive(action_queue, &action, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        ESP_LOGI(TAG, "Beacon RSSI=%d dBm, payload=%u",
                 (int)action.rssi_dbm, (unsigned)action.length);
#if CONFIG_OFFGRID_PAWR_BULK_TEST_RECEIVER
        if (pawr_bulk_test_receive(action.source_mac, action.payload,
                                   action.length)) {
            continue;
        }
#endif
        if (beacon_callback != NULL) {
            beacon_callback(action.source_mac,
                            action.payload,
                            action.length,
                            action.rssi_dbm,
                            beacon_callback_arg);
        }
    }
}

static void pawr_beacon_rx(const uint8_t source_mac[6],
                           const uint8_t *payload,
                           size_t payload_len,
                           int16_t rssi_dbm,
                           void *arg)
{
    (void)arg;
    if (action_queue == NULL || source_mac == NULL || payload == NULL ||
        payload_len > EDGEZ_PAWR_MAX_ACTION_PAYLOAD) {
        return;
    }
    struct pawr_action action = {
        .rssi_dbm = rssi_dbm,
        .length = (uint16_t)payload_len,
    };
    memcpy(action.source_mac, source_mac, sizeof(action.source_mac));
    memcpy(action.payload, payload, payload_len);
    if (xQueueSend(action_queue, &action, 0) != pdTRUE) {
        ESP_LOGW(TAG, "dropping PAwR action because the receive queue is full");
    }
}

esp_err_t halow_pawr_start(halow_pawr_beacon_callback_t callback, void *arg)
{
    if (callback == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (action_queue != NULL) {
        beacon_callback = callback;
        beacon_callback_arg = arg;
        return ESP_OK;
    }

    action_queue = xQueueCreate(PAWR_QUEUE_DEPTH, sizeof(struct pawr_action));
    if (action_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }
    beacon_callback = callback;
    beacon_callback_arg = arg;
    /* The worker decodes a maximum-size NetworkPacket and can forward it to
     * both the BLE notification queue and the mesh TX queue.  The previous
     * 4 KiB stack was exhausted by that nested protobuf/BLE call chain. */
    if (xTaskCreate(pawr_worker, "halow_pawr", 8192, NULL, 6, &worker_task) != pdPASS) {
        vQueueDelete(action_queue);
        action_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    edgez_halow_mesh_register_pawr_beacon_cb(pawr_beacon_rx, NULL);
    ESP_LOGI(TAG, "Wi-Fi HaLow PAwR responder ready");
    return ESP_OK;
}
