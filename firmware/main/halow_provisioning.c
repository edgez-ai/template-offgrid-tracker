#include "halow_provisioning.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#if CONFIG_IDF_TARGET_ESP32P4
#include "esp_wifi.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "edgez_rf_api.h"
#include "network_provisioning/manager.h"
#include "network_provisioning/scheme_ble.h"
#include "nvs.h"
#include "nvs_flash.h"

#define HALOW_NVS_NAMESPACE "halow"
#define MQTT_NVS_NAMESPACE "mqtt"
#define HALOW_PROVISIONING_ENDPOINT "mqtt-config"
#define HALOW_PROVISIONING_POP "abcd1234"

static const char *TAG = "halow_prov";
static bool provisioning_active;
static bool restart_after_stop;
#if CONFIG_DAB_WIFI_EXTENDER
static bool upstream_credentials_ready;
static bool waiting_for_upstream;
static halow_provisioning_config_t pending_gateway_config;
#endif

static bool load_string(nvs_handle_t handle, const char *key, char *value, size_t capacity)
{
    size_t length = capacity;
    return nvs_get_str(handle, key, value, &length) == ESP_OK && value[0] != '\0';
}

static esp_err_t save_config(const halow_provisioning_config_t *config)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(HALOW_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(handle, "meshId", config->mesh_id);
    if (err == ESP_OK) {
        err = nvs_set_str(handle, "passphrase", config->passphrase);
    }
    if (err == ESP_OK) {
        err = nvs_set_str(handle, "country", config->country);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(handle, "channel", config->channel);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(handle, "upstream", config->wifi_upstream ? 1U : 0U);
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err == ESP_OK && config->client_id[0] != '\0') {
        err = nvs_open(MQTT_NVS_NAMESPACE, NVS_READWRITE, &handle);
        if (err == ESP_OK) {
            err = nvs_set_str(handle, "client", config->client_id);
            if (err == ESP_OK) err = nvs_commit(handle);
            nvs_close(handle);
        }
    }
    return err;
}

static bool copy_json_string(cJSON *root, const char *key, char *value, size_t capacity)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(item) || item->valuestring == NULL) {
        return false;
    }
    const size_t length = strlen(item->valuestring);
    if (length == 0 || length >= capacity) {
        return false;
    }
    memcpy(value, item->valuestring, length + 1);
    return true;
}

esp_err_t halow_provisioning_resolve_channel(const char country[3],
                                             uint8_t channel,
                                             uint32_t *frequency_khz,
                                             uint8_t *bandwidth_mhz)
{
    if (country == NULL || country[0] == '\0' || country[1] == '\0' ||
        country[2] != '\0' || channel == 0 || frequency_khz == NULL ||
        bandwidth_mhz == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return edgez_rf_resolve_s1g_channel(country, channel, frequency_khz,
                                        bandwidth_mhz)
               ? ESP_OK
               : ESP_ERR_NOT_FOUND;
}

static void stop_and_restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750));
    if (provisioning_active) {
        network_prov_mgr_stop_provisioning();
    }
    vTaskDelete(NULL);
}

static esp_err_t config_endpoint(uint32_t session_id,
                                 const uint8_t *input,
                                 ssize_t input_length,
                                 uint8_t **output,
                                 ssize_t *output_length,
                                 void *priv_data)
{
    (void)session_id;
    (void)priv_data;
    if (input == NULL || input_length <= 0 || input_length > 1024 ||
        output == NULL || output_length == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength((const char *)input, (size_t)input_length);
    halow_provisioning_config_t candidate = {0};
    const cJSON *passphrase = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "passphrase");
    const cJSON *channel = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "halowChannel");
    const cJSON *wifi_upstream = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "wifiUpstream");
    const cJSON *client_id = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "clientId");
    bool valid = root != NULL &&
        copy_json_string(root, "meshId", candidate.mesh_id, sizeof(candidate.mesh_id)) &&
        copy_json_string(root, "country", candidate.country, sizeof(candidate.country)) &&
        strlen(candidate.country) == 2 && cJSON_IsString(passphrase) &&
        passphrase->valuestring != NULL && strlen(passphrase->valuestring) >= 8 &&
        strlen(passphrase->valuestring) < sizeof(candidate.passphrase) &&
        cJSON_IsNumber(channel) && channel->valuedouble >= 1 &&
        channel->valuedouble <= UINT8_MAX && channel->valuedouble == channel->valueint &&
        cJSON_IsBool(wifi_upstream);

    if (valid && client_id != NULL) {
        valid = copy_json_string(root, "clientId", candidate.client_id,
                                 sizeof(candidate.client_id));
    }

    uint32_t frequency_khz = 0;
    uint8_t bandwidth_mhz = 0;
    if (valid) {
        strlcpy(candidate.passphrase, passphrase->valuestring, sizeof(candidate.passphrase));
        candidate.channel = (uint8_t)channel->valueint;
        candidate.wifi_upstream = cJSON_IsTrue(wifi_upstream);
        valid = halow_provisioning_resolve_channel(candidate.country,
                                                   candidate.channel,
                                                   &frequency_khz,
                                                   &bandwidth_mhz) == ESP_OK;
    }

    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (valid) {
#if CONFIG_DAB_WIFI_EXTENDER
        if (candidate.wifi_upstream && !upstream_credentials_ready) {
            /* Do not persist a bootable gateway profile before credentials:
             * power loss during BLE setup must return to provisioning. */
            pending_gateway_config = candidate;
            err = ESP_OK;
        } else
#endif
        {
            err = save_config(&candidate);
        }
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG,
                 "Accepted mesh '%s', country %s, channel %u (%" PRIu32 " kHz/%u MHz)",
                 candidate.mesh_id, candidate.country, candidate.channel,
                 frequency_khz, bandwidth_mhz);
        restart_after_stop = true;
#if CONFIG_DAB_WIFI_EXTENDER
        waiting_for_upstream = candidate.wifi_upstream && !upstream_credentials_ready;
        if (!waiting_for_upstream &&
            xTaskCreate(stop_and_restart_task, "prov_stop", 3072, NULL, 5, NULL) != pdPASS) {
#else
        if (xTaskCreate(stop_and_restart_task, "prov_stop", 3072, NULL, 5, NULL) != pdPASS) {
#endif
            err = ESP_ERR_NO_MEM;
        }
    }

    const char *response = err == ESP_OK ?
        "{\"ok\":true}" : "{\"ok\":false,\"error\":\"invalid HaLow config\"}";
    *output_length = (ssize_t)strlen(response);
    *output = malloc((size_t)*output_length + 1U);
    if (*output == NULL) {
        *output_length = 0;
        err = ESP_ERR_NO_MEM;
    } else {
        memcpy(*output, response, (size_t)*output_length + 1U);
    }
    cJSON_Delete(root);
    return err;
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750));
    esp_restart();
}

static void provisioning_event(void *arg,
                               esp_event_base_t event_base,
                               int32_t event_id,
                               void *event_data)
{
    (void)arg;
    (void)event_data;
    if (event_base != NETWORK_PROV_EVENT) {
        return;
    }
    if (event_id == NETWORK_PROV_START) {
        ESP_LOGI(TAG, "BLE provisioning started");
    } else if (event_id == NETWORK_PROV_WIFI_CRED_FAIL) {
        ESP_LOGW(TAG, "BLE Wi-Fi credentials rejected; provisioning remains active");
        network_prov_mgr_reset_wifi_sm_state_on_failure();
#if CONFIG_DAB_WIFI_EXTENDER
    } else if (event_id == NETWORK_PROV_WIFI_CRED_SUCCESS) {
        upstream_credentials_ready = true;
        if (waiting_for_upstream && restart_after_stop) {
            const esp_err_t err = save_config(&pending_gateway_config);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "Could not save gateway profile: %s", esp_err_to_name(err));
                return;
            }
            waiting_for_upstream = false;
            network_prov_mgr_stop_provisioning();
        }
#endif
    } else if (event_id == NETWORK_PROV_END) {
        provisioning_active = false;
        network_prov_mgr_deinit();
        esp_event_handler_unregister(NETWORK_PROV_EVENT, ESP_EVENT_ANY_ID,
                                     provisioning_event);
        if (restart_after_stop &&
            xTaskCreate(restart_task, "prov_restart", 2048, NULL, 5, NULL) != pdPASS) {
            esp_restart();
        }
    }
}

esp_err_t halow_provisioning_init(halow_provisioning_config_t *config,
                                  bool *provisioned)
{
    if (config == NULL || provisioned == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        err = nvs_flash_erase();
        if (err == ESP_OK) {
            err = nvs_flash_init();
        }
    }
    if (err != ESP_OK) {
        return err;
    }

    memset(config, 0, sizeof(*config));
    nvs_handle_t handle;
    if (nvs_open(HALOW_NVS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        *provisioned = false;
        return ESP_OK;
    }
    *provisioned = load_string(handle, "meshId", config->mesh_id,
                               sizeof(config->mesh_id)) &&
        load_string(handle, "passphrase", config->passphrase,
                    sizeof(config->passphrase)) &&
        load_string(handle, "country", config->country, sizeof(config->country)) &&
        nvs_get_u8(handle, "channel", &config->channel) == ESP_OK;
    uint8_t wifi_upstream = 0;
    if (*provisioned) {
        *provisioned = nvs_get_u8(handle, "upstream", &wifi_upstream) == ESP_OK;
        config->wifi_upstream = wifi_upstream != 0;
    }
    nvs_close(handle);

    if (nvs_open(MQTT_NVS_NAMESPACE, NVS_READONLY, &handle) == ESP_OK) {
        (void)load_string(handle, "client", config->client_id,
                          sizeof(config->client_id));
        nvs_close(handle);
    }

    uint32_t frequency_khz;
    uint8_t bandwidth_mhz;
    if (*provisioned &&
        halow_provisioning_resolve_channel(config->country, config->channel,
                                           &frequency_khz, &bandwidth_mhz) != ESP_OK) {
        ESP_LOGW(TAG, "Saved HaLow channel is no longer valid; reprovisioning required");
        *provisioned = false;
    }
    return ESP_OK;
}

esp_err_t halow_provisioning_start(void)
{
    uint8_t mac[6];
#if CONFIG_IDF_TARGET_ESP32P4
    /* ESP32-P4 has no local Wi-Fi MAC in eFuse. esp_wifi_init() has already
     * initialized the ESP-Hosted remote interface, so obtain the station MAC
     * from the onboard C6 instead. */
    esp_err_t err = esp_wifi_get_mac(WIFI_IF_STA, mac);
#else
    esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
#endif
    if (err != ESP_OK) {
        return err;
    }
    char service_name[32];
    snprintf(service_name, sizeof(service_name), "PROV_%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    err = esp_event_handler_register(NETWORK_PROV_EVENT, ESP_EVENT_ANY_ID,
                                     provisioning_event, NULL);
    if (err != ESP_OK) {
        return err;
    }
    network_prov_mgr_config_t manager_config = {
        .scheme = network_prov_scheme_ble,
        .scheme_event_handler = NETWORK_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    err = network_prov_mgr_init(manager_config);
#if CONFIG_DAB_WIFI_EXTENDER
    /* The client may send mqtt-config before or after Wi-Fi credentials.
     * Keep BLE alive until both are present for a gateway profile. */
    if (err == ESP_OK) err = network_prov_mgr_disable_auto_stop(1000);
#endif
    if (err == ESP_OK) {
        err = network_prov_mgr_endpoint_create(HALOW_PROVISIONING_ENDPOINT);
    }
    if (err == ESP_OK) {
        err = network_prov_mgr_start_provisioning(NETWORK_PROV_SECURITY_1,
                                                  HALOW_PROVISIONING_POP,
                                                  service_name, NULL);
    }
    if (err == ESP_OK) {
        err = network_prov_mgr_endpoint_register(HALOW_PROVISIONING_ENDPOINT,
                                                 config_endpoint, NULL);
    }
    if (err != ESP_OK) {
        network_prov_mgr_deinit();
        esp_event_handler_unregister(NETWORK_PROV_EVENT, ESP_EVENT_ANY_ID,
                                     provisioning_event);
        return err;
    }
    provisioning_active = true;
    ESP_LOGI(TAG, "BLE service %s, PoP %s, endpoint %s", service_name,
             HALOW_PROVISIONING_POP, HALOW_PROVISIONING_ENDPOINT);
    return ESP_OK;
}
