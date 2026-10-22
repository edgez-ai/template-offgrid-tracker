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
#include "edgez_pawr_bulk.h"
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
    struct edgez_pawr_bulk_receiver receiver;
    bool invalid;
    int64_t started_us;
};

static struct pawr_bulk_receive_state bulk_state;

static uint8_t pawr_bulk_test_byte(uint8_t test_index, uint32_t offset)
{
    return (uint8_t)((offset * 29U + (uint32_t)test_index * 71U + 0x5aU) &
                     0xffU);
}

static uint32_t pawr_bulk_test_digest(uint8_t test_index, uint32_t length)
{
    uint32_t digest = UINT32_C(2166136261);
    for (uint32_t offset = 0U; offset < length; ++offset) {
        digest ^= pawr_bulk_test_byte(test_index, offset);
        digest *= UINT32_C(16777619);
    }
    return digest;
}

static bool pawr_bulk_send(void *ctx, const uint8_t destination[6],
                           const uint8_t *payload, size_t length)
{
    (void)ctx;
    return edgez_halow_mesh_transmit_pawr_control(destination, payload,
                                                   length) == ESP_OK;
}

static bool pawr_bulk_data(void *ctx,
                           const struct edgez_pawr_bulk_chunk *chunk)
{
    struct pawr_bulk_receive_state *state = ctx;
    if ((chunk->flags & EDGEZ_PAWR_BULK_FLAG_FIRST) != 0U) {
        state->invalid = false;
        bulk_state.started_us = esp_timer_get_time();
    }
    for (uint16_t i = 0U; i < chunk->data_length; ++i) {
        if (chunk->data[i] != pawr_bulk_test_byte(
                                  chunk->test_index, chunk->offset + i)) {
            state->invalid = true;
            break;
        }
    }
    return true;
}

static void pawr_bulk_done(void *ctx,
                           const struct edgez_pawr_bulk_transfer *transfer,
                           bool success)
{
    struct pawr_bulk_receive_state *state = ctx;
    const struct edgez_pawr_bulk_receiver_stats *stats =
        &state->receiver.stats;
    const uint32_t digest = pawr_bulk_test_digest(
        transfer->test_index, transfer->total_length);
    const bool passed = success && !state->invalid &&
        digest == transfer->expected_digest;
    const uint32_t elapsed_ms = (uint32_t)(
        (esp_timer_get_time() - state->started_us) / 1000);

    ESP_LOGI(TAG,
                 "PAWR_BULK_TEST %s test=%u bytes=%" PRIu32
                 " chunks=%u frames=%u duplicates=%u stale=%u "
                 "block_acks=%u ack_queries=%u elapsed_ms=%" PRIu32
                 " digest=%08" PRIx32
                 " source=%02x:%02x:%02x:%02x:%02x:%02x",
                 passed ? "PASS" : "FAIL", (unsigned)transfer->test_index,
                 stats->bytes_received, (unsigned)stats->chunks_received,
                 (unsigned)stats->frames, (unsigned)stats->duplicates,
                 (unsigned)stats->stale, (unsigned)stats->block_acks,
                 (unsigned)stats->ack_queries, elapsed_ms, digest,
                 state->receiver.peer[0], state->receiver.peer[1],
                 state->receiver.peer[2], state->receiver.peer[3],
                 state->receiver.peer[4], state->receiver.peer[5]);

        const struct edgez_pawr_bulk_regulatory *reg = &transfer->regulatory;
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
            (stats->bytes_received * 8U) / elapsed_ms;

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
                 stats->bytes_received, elapsed_ms, goodput_kbps);
}

static bool pawr_bulk_test_receive(const uint8_t source_mac[6],
                                   const uint8_t *payload,
                                   size_t payload_len)
{
    return edgez_pawr_bulk_receiver_feed(&bulk_state.receiver, source_mac,
                                          payload, payload_len);
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
#if CONFIG_OFFGRID_PAWR_BULK_TEST_RECEIVER
    const struct edgez_pawr_bulk_receiver_config bulk_config = {
        .send = pawr_bulk_send,
        .data = pawr_bulk_data,
        .done = pawr_bulk_done,
        .ctx = &bulk_state,
    };
    if (!edgez_pawr_bulk_receiver_init(&bulk_state.receiver, &bulk_config)) {
        vQueueDelete(action_queue);
        action_queue = NULL;
        return ESP_ERR_INVALID_STATE;
    }
#endif
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
