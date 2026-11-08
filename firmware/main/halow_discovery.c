#include "halow_discovery.h"
#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32S3
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "edgez_pawr_protocol.h"
#include "edgez_halow_mesh_service.h"
#include "wifi_mqtt.h"

#define DISCOVERY_SLOTS 8
#define ACCEPTANCE_MAX (EDGEZ_PAWR_MAX_ACTION_PAYLOAD - EDGEZ_PAWR_HEADER_LENGTH)
#define CACHE_TTL_MS 900000
static const char *TAG = "halow_discovery";
static portMUX_TYPE cache_lock = portMUX_INITIALIZER_UNLOCKED;
struct discovery_entry {
    bool valid;
    uint8_t source[6];
    int64_t last_seen;
    size_t length;
    uint8_t acceptance[ACCEPTANCE_MAX];
};
static struct discovery_entry cache[DISCOVERY_SLOTS];
static size_t next_entry;
static uint32_t request_id;

static uint32_t discovery_ssid(void)
{
    return edgez_pawr_compress_ssid((const uint8_t *)EDGEZ_PAWR_ZERO_TOUCH_SSID,
                                  sizeof(EDGEZ_PAWR_ZERO_TOUCH_SSID)-1);
}

void halow_discovery_tick(void)
{
    static int64_t last_advertisement;
    int64_t now = esp_timer_get_time() / 1000;
    if (!wifi_mqtt_ready(NULL) || now - last_advertisement < 1000) return;
    uint8_t response[EDGEZ_PAWR_HEADER_LENGTH];
    static const uint8_t broadcast[6] = {0xff,0xff,0xff,0xff,0xff,0xff};
    size_t length;
    if (edgez_pawr_encode_response(response, sizeof(response), 0, discovery_ssid(), &length))
        (void)edgez_halow_mesh_transmit_pawr_control(broadcast, response, length);
    last_advertisement = now;
}

bool halow_discovery_accept(const uint8_t *payload, size_t length)
{
    uint8_t destination[6];
    if (!payload || length == 0 || length > ACCEPTANCE_MAX ||
        !edgez_pawr_packet_destination(payload, length, destination)) return false;
    bool stored = false;
    int64_t now = esp_timer_get_time() / 1000;
    taskENTER_CRITICAL(&cache_lock);
    for (size_t i = 0; i < DISCOVERY_SLOTS; i++) {
        struct discovery_entry *entry = &cache[i];
        if (entry->valid && now - entry->last_seen < CACHE_TTL_MS &&
            memcmp(entry->source, destination, 6) == 0) {
            memcpy(entry->acceptance, payload, length);
            entry->length = length;
            stored = true;
            break;
        }
    }
    taskEXIT_CRITICAL(&cache_lock);
    ESP_LOGI(TAG, "Encrypted sensor acceptance %s, bytes=%u", stored ? "cached" : "has no recent discovery", (unsigned)length);
    return stored;
}

bool halow_discovery_receive(const uint8_t source[6], const uint8_t *payload, size_t length)
{
    const bool discovery = edgez_pawr_is_sensor_discovery(source, payload, length);
    int64_t now = esp_timer_get_time() / 1000;
    uint8_t *reply = NULL;
    size_t reply_length = 0;
    bool confirm = false;
    /* Allocate outside the critical section; only cached bytes are copied in it. */
    if (discovery) reply = malloc(ACCEPTANCE_MAX + EDGEZ_PAWR_HEADER_LENGTH);
    taskENTER_CRITICAL(&cache_lock);
    struct discovery_entry *entry = NULL;
    for (size_t i = 0; i < DISCOVERY_SLOTS; i++) {
        if (cache[i].valid && now - cache[i].last_seen < CACHE_TTL_MS &&
            memcmp(cache[i].source, source, 6) == 0) { entry = &cache[i]; break; }
    }
    if (discovery) {
        if (!entry) {
            entry = &cache[next_entry++ % DISCOVERY_SLOTS];
            memset(entry, 0, sizeof(*entry));
            entry->valid = true;
            memcpy(entry->source, source, 6);
        }
        entry->last_seen = now;
        if (reply && entry->length) {
            reply_length = entry->length;
            memcpy(reply + EDGEZ_PAWR_HEADER_LENGTH, entry->acceptance, reply_length);
        }
    } else if (entry && entry->length) confirm = true;
    taskEXIT_CRITICAL(&cache_lock);
    if (discovery) {
        int published = wifi_mqtt_publish("system/discover", payload, length, 1, false, NULL);
        ESP_LOGI(TAG, "Sensor discovery %02X:%02X:%02X:%02X:%02X:%02X bytes=%u MQTT=%d",
                 source[0],source[1],source[2],source[3],source[4],source[5],(unsigned)length,published);
        if (reply_length) {
            size_t encoded;
            if (edgez_pawr_encode_mesh_packet(reply, ACCEPTANCE_MAX + EDGEZ_PAWR_HEADER_LENGTH,
                    ++request_id, discovery_ssid(), reply + EDGEZ_PAWR_HEADER_LENGTH, reply_length, &encoded))
                (void)edgez_halow_mesh_transmit_pawr_control(source, reply, encoded);
        }
    } else if (confirm && wifi_mqtt_publish("system/accepted", source, 6, 1, false, NULL) >= 0) {
        taskENTER_CRITICAL(&cache_lock);
        for (size_t i = 0; i < DISCOVERY_SLOTS; i++)
            if (cache[i].valid && memcmp(cache[i].source, source, 6) == 0) cache[i].length = 0;
        taskEXIT_CRITICAL(&cache_lock);
        ESP_LOGI(TAG, "Sensor acceptance confirmed by operational uplink");
    }
    free(reply);
    return discovery;
}

#else
/* The HC33 receiver update uses the ESP32-S3 SDK archive. */
void halow_discovery_tick(void) {}
bool halow_discovery_receive(const uint8_t source[6], const uint8_t *payload, size_t length)
{ (void)source; (void)payload; (void)length; return false; }
bool halow_discovery_accept(const uint8_t *payload, size_t length)
{ (void)payload; (void)length; return false; }
#endif
