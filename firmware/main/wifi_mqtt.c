#include "wifi_mqtt.h"

#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "mqtt_client.h"
#if CONFIG_DAB_START_MQTT_RELAY
#include "mesh_mqtt_relay.h"
#endif

static const char *TAG = "wifi_mqtt";
static esp_mqtt_client_handle_t client;
static esp_netif_t *station;
static atomic_bool online;
static atomic_bool relay_started;
static bool client_started;
static char topic_prefix[160];

static void set_online(bool connected)
{
    atomic_store(&online, connected);
#if CONFIG_DAB_START_MQTT_RELAY
    if (atomic_load(&relay_started)) edgez_mqtt_set_gateway_online(connected);
#endif
}

void wifi_mqtt_relay_started(void)
{
    atomic_store(&relay_started, true);
#if CONFIG_DAB_START_MQTT_RELAY
    edgez_mqtt_set_gateway_online(atomic_load(&online));
#endif
}

static void mqtt_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    const esp_mqtt_event_handle_t event = data;
    if (id == MQTT_EVENT_CONNECTED) {
        set_online(true);
        ESP_LOGI(TAG, "MQTT connected directly over Wi-Fi");
    } else if (id == MQTT_EVENT_DISCONNECTED) {
        set_online(false);
        ESP_LOGW(TAG, "MQTT disconnected; automatic reconnect enabled");
    } else if (id == MQTT_EVENT_ERROR) {
        const esp_mqtt_error_codes_t *error = event->error_handle;
        ESP_LOGW(TAG, "MQTT connection error type=%d esp_tls=0x%x tls=0x%x broker_rc=%d internal_free=%u largest=%u",
                 error ? error->error_type : 0,
                 error ? error->esp_tls_last_esp_err : 0,
                 error ? -error->esp_tls_stack_err : 0,
                 error ? error->connect_return_code : 0,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT &&
        (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        set_online(false);
        const esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) ESP_LOGW(TAG, "Wi-Fi connect failed: %s", esp_err_to_name(err));
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = data;
        if (event->esp_netif != station) return;
        (void)esp_netif_sntp_start();
        ESP_LOGI(TAG, "Wi-Fi obtained IP; MQTT broker %s", CONFIG_DAB_MQTT_BROKER_URI);
        if (!client_started) {
            const esp_err_t err = esp_mqtt_client_start(client);
            client_started = err == ESP_OK;
            if (err != ESP_OK) ESP_LOGE(TAG, "MQTT start failed: %s", esp_err_to_name(err));
        }
    }
}

bool wifi_mqtt_ready(void *arg)
{
    (void)arg;
    return atomic_load(&online);
}

int wifi_mqtt_publish(const char *topic, const void *payload, size_t length,
                      int qos, bool retain, void *arg)
{
    (void)arg;
    if (!wifi_mqtt_ready(NULL) || !topic || !payload || length > INT_MAX ||
        (strcmp(topic, "system/status") != 0 && strcmp(topic, "telemetry/sensors") != 0)) return -1;
    char full_topic[192];
    const int count = snprintf(full_topic, sizeof(full_topic), "%s/%s", topic_prefix, topic);
    if (count < 0 || (size_t)count >= sizeof(full_topic)) return -1;
    return esp_mqtt_client_enqueue(client, full_topic, payload, (int)length,
                                    qos, retain, true);
}

esp_err_t wifi_mqtt_start(const halow_provisioning_config_t *config)
{
    if (!config || !config->wifi_upstream || !config->client_id[0] ||
        !config->mqtt_username[0] || !config->mqtt_password[0] || !config->project_id[0])
        return ESP_ERR_INVALID_ARG;
    if (client) return ESP_ERR_INVALID_STATE;

    const int count = snprintf(topic_prefix, sizeof(topic_prefix), "projects/%s/devices/%s",
                               config->project_id, config->mqtt_username);
    if (count < 0 || (size_t)count >= sizeof(topic_prefix)) return ESP_ERR_INVALID_SIZE;
    const esp_mqtt_client_config_t mqtt_config = {
        .broker.address.uri = CONFIG_DAB_MQTT_BROKER_URI,
        .broker.verification.crt_bundle_attach = esp_crt_bundle_attach,
        .credentials.client_id = config->client_id,
        .credentials.username = config->mqtt_username,
        .credentials.authentication.password = config->mqtt_password,
        .network.reconnect_timeout_ms = 5000,
        .outbox.limit = 65536,
    };
    client = esp_mqtt_client_init(&mqtt_config);
    if (!client) return ESP_ERR_NO_MEM;
    esp_err_t err = esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event, NULL);
    if (err != ESP_OK) return err;

    /* Verified TLS needs a valid clock. SNTP starts when STA receives an IP;
     * MQTT retries if its first handshake precedes time synchronization. */
    esp_sntp_config_t time_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    time_config.start = false;
    time_config.server_from_dhcp = false;
    err = esp_netif_sntp_init(&time_config);
    if (err != ESP_OK) return err;

    station = esp_netif_create_default_wifi_sta();
    if (!station) return ESP_ERR_NO_MEM;
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&init);
    if (err != ESP_OK) return err;
    err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) return err;
    wifi_config_t saved = {0};
    err = esp_wifi_get_config(WIFI_IF_STA, &saved);
    if (err != ESP_OK) return err;
    if (!saved.sta.ssid[0]) return ESP_ERR_INVALID_STATE;
    err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL);
    if (err != ESP_OK) return err;
    err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL);
    if (err != ESP_OK) return err;
    return esp_wifi_start();
}
