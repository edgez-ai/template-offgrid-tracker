#include "halow_pawr.h"

#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "edgez_halow_mesh_service.h"
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
    if (xTaskCreate(pawr_worker, "halow_pawr", 4096, NULL, 6, &worker_task) != pdPASS) {
        vQueueDelete(action_queue);
        action_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    edgez_halow_mesh_register_pawr_beacon_cb(pawr_beacon_rx, NULL);
    ESP_LOGI(TAG, "Wi-Fi HaLow PAwR responder ready");
    return ESP_OK;
}
