#include "halow_pawr.h"

#include <inttypes.h>
#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "edgez_pawr_protocol.h"
#include "mmwlan.h"

#define PAWR_QUEUE_DEPTH 4U

static const char *TAG = "halow_pawr";
static const uint8_t EDGEZ_ACTION_OUI[MMWLAN_OUI_SIZE] = {'E', 'd', 'g'};

struct pawr_action {
    uint8_t source_mac[MMWLAN_MAC_ADDR_LEN];
    int16_t rssi_dbm;
    uint16_t length;
    uint8_t payload[MMWLAN_VENDOR_ACTION_MAX_PAYLOAD];
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
        struct edgez_pawr_request_view request;
        if (!edgez_pawr_decode_request(action.payload, action.length, &request)) {
            continue;
        }
        ESP_LOGI(TAG, "request=%" PRIu32 ", RSSI=%d dBm, payload=%u",
                 request.request_id, (int)action.rssi_dbm,
                 (unsigned)request.payload_length);
        if (beacon_callback != NULL) {
            beacon_callback(action.source_mac,
                            request.payload,
                            request.payload_length,
                            action.rssi_dbm,
                            beacon_callback_arg);
        }
    }
}

static void vendor_action_rx(const uint8_t source_mac[MMWLAN_MAC_ADDR_LEN],
                             const uint8_t *payload,
                             size_t payload_len,
                             int16_t rssi_dbm,
                             void *arg)
{
    (void)arg;
    if (action_queue == NULL || source_mac == NULL || payload == NULL ||
        payload_len > MMWLAN_VENDOR_ACTION_MAX_PAYLOAD) {
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
    if (mmwlan_register_vendor_action_rx_cb(EDGEZ_ACTION_OUI, vendor_action_rx, NULL) !=
        MMWLAN_SUCCESS) {
        vTaskDelete(worker_task);
        worker_task = NULL;
        vQueueDelete(action_queue);
        action_queue = NULL;
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "Wi-Fi HaLow PAwR responder ready");
    return ESP_OK;
}

esp_err_t halow_pawr_ack_beacon(const uint8_t destination_mac[6],
                               const uint8_t *beacon,
                               size_t length)
{
    if (destination_mac == NULL || beacon == NULL || length == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t frame[EDGEZ_PAWR_HEADER_LENGTH];
    size_t frame_length;
    if (!edgez_pawr_encode_response(frame, sizeof(frame),
                                    edgez_pawr_payload_hash(beacon, length),
                                    &frame_length)) {
        return ESP_ERR_INVALID_SIZE;
    }

    return mmwlan_send_vendor_action(destination_mac,
                                     EDGEZ_ACTION_OUI,
                                     frame,
                                     frame_length) == MMWLAN_SUCCESS
               ? ESP_OK
               : ESP_FAIL;
}
