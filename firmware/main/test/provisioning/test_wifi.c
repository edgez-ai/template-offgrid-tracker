#include <assert.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "wifi_mqtt.h"
#include "mesh_mqtt_relay.h"

#define CONFIG_DAB_START_MQTT_RELAY 1
#define CONFIG_DAB_MQTT_BROKER_URI "mqtts://mqtt.example:8883"
#define ESP_ERR_INVALID_STATE 7
#define ESP_ERR_INVALID_SIZE 8
#define WIFI_EVENT 1
#define IP_EVENT 2
#define WIFI_EVENT_STA_START 1
#define WIFI_EVENT_STA_DISCONNECTED 2
#define IP_EVENT_STA_GOT_IP 3
#define MQTT_EVENT_CONNECTED 4
#define MQTT_EVENT_DISCONNECTED 5
#define MQTT_EVENT_ERROR 6
#define ESP_EVENT_ANY_ID -1
#define WIFI_MODE_STA 1
#define WIFI_IF_STA 1
static void log_message(const char *tag, const char *format, ...) { (void)tag; (void)format; }
static const char *esp_err_to_name(int error) { (void)error; return "error"; }
#define ESP_LOGI(...) log_message(__VA_ARGS__)
#define ESP_LOGW(...) log_message(__VA_ARGS__)
#define ESP_LOGE(...) log_message(__VA_ARGS__)
typedef int esp_event_base_t;
typedef int esp_netif_t;
typedef struct { esp_netif_t *esp_netif; } ip_event_got_ip_t;
typedef struct { int error_type, esp_tls_last_esp_err, esp_tls_stack_err, connect_return_code; } esp_mqtt_error_codes_t;
typedef esp_mqtt_error_codes_t mqtt_error_t;
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
static size_t heap_caps_get_free_size(unsigned caps) { (void)caps; return 65536; }
static size_t heap_caps_get_largest_free_block(unsigned caps) { (void)caps; return 32768; }
typedef struct { mqtt_error_t *error_handle; } mqtt_event_data_t;
typedef mqtt_event_data_t *esp_mqtt_event_handle_t;
typedef struct {
    struct { struct { const char *uri; } address;
        struct { esp_err_t (*crt_bundle_attach)(void *); } verification; } broker;
    struct { const char *client_id, *username;
        struct { const char *password; } authentication; } credentials;
    struct { int reconnect_timeout_ms; } network;
    struct { unsigned limit; } outbox;
} esp_mqtt_client_config_t;
typedef void *esp_mqtt_client_handle_t;
typedef struct { bool start, server_from_dhcp; } esp_sntp_config_t;
#define ESP_NETIF_SNTP_DEFAULT_CONFIG(server) { .start = true }
typedef int wifi_init_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() 0
typedef struct { struct { uint8_t ssid[32]; } sta; } wifi_config_t;
static int station_instance, other_instance;
static unsigned wifi_connects, mqtt_starts, publishes, time_starts;
static bool gateway_online;
static esp_mqtt_client_config_t saved_mqtt;
static char published_topic[192];
static uint8_t published_payload[16];
static size_t published_length;
static esp_err_t esp_crt_bundle_attach(void *config) { (void)config; return ESP_OK; }
static esp_mqtt_client_handle_t esp_mqtt_client_init(const esp_mqtt_client_config_t *config)
{ saved_mqtt = *config; return &saved_mqtt; }
static int esp_mqtt_client_start(esp_mqtt_client_handle_t handle)
{ assert(handle == &saved_mqtt); ++mqtt_starts; return ESP_OK; }
static int esp_mqtt_client_enqueue(esp_mqtt_client_handle_t handle, const char *topic,
                                    const void *payload, int length, int qos, bool retain, bool store)
{
    assert(handle == &saved_mqtt && qos == 1 && !retain && store);
    assert(length >= 0 && length <= (int)sizeof(published_payload));
    strcpy(published_topic, topic); memcpy(published_payload, payload, length);
    published_length = length; return ++publishes;
}
typedef void (*event_fn_t)(void *, esp_event_base_t, int32_t, void *);
static int esp_mqtt_client_register_event(void *handle, int id, event_fn_t fn, void *arg)
{ (void)handle; (void)id; (void)fn; (void)arg; return ESP_OK; }
static int esp_event_handler_register(int base, int id, event_fn_t fn, void *arg)
{ (void)base; (void)id; (void)fn; (void)arg; return ESP_OK; }
static int esp_netif_sntp_init(const esp_sntp_config_t *config) { assert(!config->start); return ESP_OK; }
static int esp_netif_sntp_start(void) { ++time_starts; return ESP_OK; }
static esp_netif_t *esp_netif_create_default_wifi_sta(void) { return &station_instance; }
static int esp_wifi_init(const wifi_init_config_t *config) { (void)config; return ESP_OK; }
static int esp_wifi_set_mode(int mode) { assert(mode == WIFI_MODE_STA); return ESP_OK; }
static int esp_wifi_get_config(int mode, wifi_config_t *config)
{ assert(mode == WIFI_IF_STA); memcpy(config->sta.ssid, "test-network", 13); return ESP_OK; }
static int esp_wifi_connect(void) { ++wifi_connects; return ESP_OK; }
static int esp_wifi_start(void) { return ESP_OK; }
void edgez_mqtt_set_gateway_online(bool ready) { gateway_online = ready; }
#include "wifi.inc"

int main(void)
{
    halow_provisioning_config_t config = {0};
    assert(wifi_mqtt_start(&config) == ESP_ERR_INVALID_ARG); /* mesh-only must not start Wi-Fi */
    config.wifi_upstream = true;
    strcpy(config.client_id, "33c84b34-4599-4ed9-894f-b5f48df6fd8c");
    strcpy(config.project_id, "project-a");
    strcpy(config.mqtt_username, "AABBCCDDEEFF"); strcpy(config.mqtt_password, "mqtt-secret");
    assert(wifi_mqtt_start(&config) == ESP_OK);
    assert(!strcmp(saved_mqtt.credentials.client_id, config.client_id));
    assert(!strcmp(saved_mqtt.credentials.username, config.mqtt_username));
    assert(!strcmp(saved_mqtt.credentials.authentication.password, config.mqtt_password));
    assert(saved_mqtt.broker.verification.crt_bundle_attach == esp_crt_bundle_attach);
    assert(mqtt_starts == 0 && !wifi_mqtt_ready(NULL));
    wifi_event(NULL, WIFI_EVENT, WIFI_EVENT_STA_START, NULL);
    assert(wifi_connects == 1);
    ip_event_got_ip_t ip = { .esp_netif = &other_instance };
    wifi_event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &ip);
    assert(mqtt_starts == 0);
    ip.esp_netif = &station_instance;
    wifi_event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &ip);
    assert(mqtt_starts == 1 && time_starts == 1);
    mqtt_event(NULL, 0, MQTT_EVENT_CONNECTED, NULL);
    assert(wifi_mqtt_ready(NULL) && !gateway_online);
    wifi_mqtt_relay_started(); assert(gateway_online);
    const uint8_t binary[] = {0, 255, 0, 12};
    assert(wifi_mqtt_publish("system/status", binary, sizeof(binary), 1, false, NULL) > 0);
    assert(!strcmp(published_topic, "projects/project-a/devices/AABBCCDDEEFF/system/status"));
    assert(published_length == sizeof(binary) && !memcmp(published_payload, binary, sizeof(binary)));
    assert(wifi_mqtt_publish("telemetry/sensors", binary, sizeof(binary), 1, false, NULL) > 0);
    assert(!strcmp(published_topic, "projects/project-a/devices/AABBCCDDEEFF/telemetry/sensors"));
    assert(wifi_mqtt_publish("unexpected", binary, sizeof(binary), 1, false, NULL) < 0);
    const uint8_t camera_mac[] = {2, 0, 4, 0xe1, 0x51, 0x74};
    assert(wifi_mqtt_publish_block(camera_mac, binary, sizeof(binary)) > 0);
    assert(!strcmp(published_topic, "projects/project-a/devices/AABBCCDDEEFF/telemetry/blocks/02:00:04:E1:51:74"));
    wifi_event(NULL, WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, NULL);
    assert(wifi_connects == 2 && !wifi_mqtt_ready(NULL) && !gateway_online);
    assert(wifi_mqtt_publish("system/status", binary, sizeof(binary), 1, false, NULL) < 0);
    wifi_event(NULL, IP_EVENT, IP_EVENT_STA_GOT_IP, &ip);
    assert(mqtt_starts == 1); /* reconnect reuses the existing MQTT client */
    mqtt_event(NULL, 0, MQTT_EVENT_CONNECTED, NULL); assert(gateway_online);
    mqtt_event(NULL, 0, MQTT_EVENT_DISCONNECTED, NULL);
    assert(!wifi_mqtt_ready(NULL) && !gateway_online);
    mqtt_error_t error = { .error_type = 1, .esp_tls_stack_err = -0x7f00 };
    mqtt_event_data_t failure = { .error_handle = &error };
    mqtt_event(NULL, 0, MQTT_EVENT_ERROR, &failure);
    puts("Wi-Fi/MQTT lifecycle checks passed");
    return 0;
}
