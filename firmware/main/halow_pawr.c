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
    bool reported;
    bool window_active;
    uint8_t source_mac[6];
    uint8_t test_index;
    uint32_t session_id;
    uint32_t total_length;
    uint32_t expected_digest;
    uint32_t digest;
    uint32_t received;
    uint16_t unique_chunks;
    uint16_t frames_received;
    uint16_t window_id;
    uint16_t window_base_chunk;
    uint8_t window_count;
    uint32_t window_bitmap;
    uint16_t block_acks;
    uint16_t ack_queries;
    uint16_t duplicate_chunks;
    uint16_t stale_frames;
    uint32_t received_map[16];
    struct edgez_pawr_bulk_regulatory regulatory;
    bool saw_last;
    int64_t started_us;
};

static struct pawr_bulk_receive_state bulk_state;

static bool pawr_bulk_send_block_ack(const uint8_t destination[6])
{
    uint8_t payload[EDGEZ_PAWR_BULK_CONTROL_SIZE];
    const struct edgez_pawr_bulk_control ack = {
        .kind = EDGEZ_PAWR_BULK_KIND_BLOCK_ACK,
        .session_id = bulk_state.session_id,
        .bitmap = bulk_state.window_bitmap,
        .window_id = bulk_state.window_id,
        .base_chunk = bulk_state.window_base_chunk,
        .chunk_count = bulk_state.window_count,
        .test_index = bulk_state.test_index,
    };
    const size_t length = edgez_pawr_bulk_control_encode(
        payload, sizeof(payload), &ack);
    if (length == 0U || edgez_halow_mesh_transmit_pawr_control(
            destination, payload, length) != ESP_OK) {
        ESP_LOGW(TAG, "PAWR_BULK_ACK send failed window=%u bitmap=%08" PRIx32,
                 (unsigned)bulk_state.window_id, bulk_state.window_bitmap);
        return false;
    }
    bulk_state.block_acks++;
    return true;
}

static bool pawr_bulk_test_receive(const uint8_t source_mac[6],
                                   const uint8_t *payload,
                                   size_t payload_len)
{
    struct edgez_pawr_bulk_chunk chunk;
    struct edgez_pawr_bulk_control control;

    if (edgez_pawr_bulk_control_decode(payload, payload_len, &control)) {
        if (control.kind != EDGEZ_PAWR_BULK_KIND_ACK_QUERY) {
            return true;
        }
        if (bulk_state.active &&
            memcmp(bulk_state.source_mac, source_mac,
                   sizeof(bulk_state.source_mac)) == 0 &&
            edgez_pawr_bulk_control_matches(
                &control, bulk_state.session_id, bulk_state.test_index,
                bulk_state.window_id, bulk_state.window_base_chunk,
                bulk_state.window_count)) {
            bulk_state.ack_queries++;
            (void)pawr_bulk_send_block_ack(source_mac);
        } else if (bulk_state.active) {
            bulk_state.stale_frames++;
        }
        return true;
    }

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
        bulk_state.regulatory = chunk.regulatory;
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

    if (!bulk_state.window_active || chunk.window_id > bulk_state.window_id) {
        if (bulk_state.window_active &&
            chunk.window_id != (uint16_t)(bulk_state.window_id + 1U)) {
            bulk_state.stale_frames++;
            return true;
        }
        bulk_state.window_active = true;
        bulk_state.window_id = chunk.window_id;
        bulk_state.window_base_chunk = chunk.window_base_chunk;
        bulk_state.window_count = chunk.window_count;
        bulk_state.window_bitmap = 0U;
    } else if (chunk.window_id < bulk_state.window_id) {
        bulk_state.stale_frames++;
        return true;
    } else if (chunk.window_base_chunk != bulk_state.window_base_chunk ||
               chunk.window_count != bulk_state.window_count) {
        bulk_state.invalid = true;
        return true;
    }

    if (memcmp(&bulk_state.regulatory, &chunk.regulatory,
               sizeof(bulk_state.regulatory)) != 0) {
        bulk_state.invalid = true;
    }

    bulk_state.frames_received++;
    if (chunk.chunk_index >= 512U) {
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
    } else {
        bulk_state.duplicate_chunks++;
    }
    bulk_state.window_bitmap |= UINT32_C(1) <<
        (chunk.chunk_index - bulk_state.window_base_chunk);

    if ((chunk.flags & EDGEZ_PAWR_BULK_FLAG_ACK_REQUEST) != 0U) {
        (void)pawr_bulk_send_block_ack(source_mac);
    }

    bulk_state.saw_last |=
        (chunk.flags & EDGEZ_PAWR_BULK_FLAG_LAST) != 0U;
    if (!bulk_state.reported && bulk_state.saw_last &&
        bulk_state.received >= bulk_state.total_length) {
        const bool passed = !bulk_state.invalid &&
            bulk_state.received == bulk_state.total_length &&
            bulk_state.digest == bulk_state.expected_digest;
        const uint32_t elapsed_ms = (uint32_t)(
            (esp_timer_get_time() - bulk_state.started_us) / 1000);

        ESP_LOGI(TAG,
                 "PAWR_BULK_TEST %s test=%u bytes=%" PRIu32
                 " chunks=%u frames=%u duplicates=%u stale=%u "
                 "block_acks=%u ack_queries=%u elapsed_ms=%" PRIu32
                 " digest=%08" PRIx32
                 " source=%02x:%02x:%02x:%02x:%02x:%02x",
                 passed ? "PASS" : "FAIL", (unsigned)bulk_state.test_index,
                 bulk_state.received, (unsigned)bulk_state.unique_chunks,
                 (unsigned)bulk_state.frames_received,
                 (unsigned)bulk_state.duplicate_chunks,
                 (unsigned)bulk_state.stale_frames,
                 (unsigned)bulk_state.block_acks,
                 (unsigned)bulk_state.ack_queries, elapsed_ms,
                 bulk_state.digest, source_mac[0], source_mac[1],
                 source_mac[2], source_mac[3], source_mac[4], source_mac[5]);

        const struct edgez_pawr_bulk_regulatory *reg =
            &bulk_state.regulatory;
        const bool country_ok = strcmp(reg->country_code, "EU") == 0;
        const bool channel_ok = reg->frequency_khz >= 863500U &&
            reg->frequency_khz <= 867500U;
        const bool bandwidth_ok = reg->bandwidth_mhz == 1U;
        const bool duty_ok =
            (reg->flags & EDGEZ_PAWR_BULK_REG_FLAG_CHIP_DUTY_VALID) != 0U &&
            reg->duty_cycle_centi_percent <= 280U;
        const bool eirp_config_ok =
            (reg->flags & EDGEZ_PAWR_BULK_REG_FLAG_REGDB_VALID) != 0U &&
            reg->max_eirp_dbm <= 16;
        const bool terminal_ok =
            (reg->flags & EDGEZ_PAWR_BULK_REG_FLAG_TERMINAL_NODE) != 0U;
        const bool config_pass = country_ok && channel_ok && bandwidth_ok &&
            duty_ok && eirp_config_ok && terminal_ok;
        const uint32_t goodput_kbps = elapsed_ms == 0U ? 0U :
            (bulk_state.received * 8U) / elapsed_ms;

        ESP_LOGI(TAG,
                 "EU_COMPLIANCE_PRECHECK %s standard=EN304220-2 role=terminal "
                 "country=%s frequency_khz=%" PRIu32 " bandwidth_mhz=%u "
                 "sender_duty=%u.%02u%% duty_mode=%s eirp_cap_dbm=%d "
                 "receiver_profile=%s/%u/%uMHz eirp_measurement=UNKNOWN",
                 config_pass ? "CONFIG_PASS" : "CONFIG_FAIL",
                 reg->country_code, reg->frequency_khz,
                 (unsigned)reg->bandwidth_mhz,
                 (unsigned)(reg->duty_cycle_centi_percent / 100U),
                 (unsigned)(reg->duty_cycle_centi_percent % 100U),
                 reg->duty_cycle_mode == 0U ? "spread" : "burst",
                 (int)reg->max_eirp_dbm,
                 CONFIG_HALOW_COUNTRY_CODE,
                 (unsigned)CONFIG_HALOW_MESH_FREQUENCY_KHZ,
                 (unsigned)CONFIG_HALOW_MESH_BANDWIDTH_MHZ);
        ESP_LOGI(TAG,
                 "PAWR_ENERGY_PRECHECK bytes=%" PRIu32
                 " active_ms=%" PRIu32 " goodput_kbps=%" PRIu32
                 " energy_mj=UNKNOWN current_measurement=REQUIRED",
                 bulk_state.received, elapsed_ms, goodput_kbps);
        bulk_state.reported = true;
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
