#include "halow_provisioning.h"

#include <inttypes.h>
#include <math.h>
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
#define HALOW_PROVISIONING_ENDPOINT "mqtt-config"
#define HALOW_PROVISIONING_POP "abcd1234"

/* Keep ESP provisioning discoverable by the app's FFF0-filtered BLE scan.
 * ESP-IDF expects the 128-bit UUID in least-significant-byte-first order. */
static uint8_t edgez_provisioning_service_uuid[16] = {
    0xfb, 0x34, 0x9b, 0x5f, 0x80, 0x00, 0x00, 0x80,
    0x00, 0x10, 0x00, 0x00, 0xf0, 0xff, 0x00, 0x00,
};

static const char *TAG = "halow_prov";
static bool provisioning_active;
static bool restart_after_stop;

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
        err = nvs_set_str(handle, "deviceUuid", config->client_id);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(handle, "hasLocation", config->has_location ? 1U : 0U);
    }
    if (err == ESP_OK && config->has_location) {
        err = nvs_set_blob(handle, "latitude", &config->latitude,
                           sizeof(config->latitude));
    }
    if (err == ESP_OK && config->has_location) {
        err = nvs_set_blob(handle, "longitude", &config->longitude,
                           sizeof(config->longitude));
    }
    if (err == ESP_OK && !config->has_location) {
        const esp_err_t latitude_err = nvs_erase_key(handle, "latitude");
        const esp_err_t longitude_err = nvs_erase_key(handle, "longitude");
        if (latitude_err != ESP_OK && latitude_err != ESP_ERR_NVS_NOT_FOUND) {
            err = latitude_err;
        } else if (longitude_err != ESP_OK &&
                   longitude_err != ESP_ERR_NVS_NOT_FOUND) {
            err = longitude_err;
        }
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
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

static bool valid_uuid(const char *value)
{
    if (value == NULL || strlen(value) != 36U) {
        return false;
    }
    for (size_t i = 0; i < 36U; ++i) {
        const char c = value[i];
        if (i == 8U || i == 13U || i == 18U || i == 23U) {
            if (c != '-') return false;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                     (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
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
    const cJSON *latitude = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "latitude");
    const cJSON *longitude = root == NULL ? NULL :
        cJSON_GetObjectItemCaseSensitive(root, "longitude");
    bool valid = root != NULL &&
        copy_json_string(root, "clientId", candidate.client_id, sizeof(candidate.client_id)) &&
        valid_uuid(candidate.client_id) &&
        copy_json_string(root, "meshId", candidate.mesh_id, sizeof(candidate.mesh_id)) &&
        copy_json_string(root, "country", candidate.country, sizeof(candidate.country)) &&
        strlen(candidate.country) == 2 && cJSON_IsString(passphrase) &&
        passphrase->valuestring != NULL &&
        (strlen(passphrase->valuestring) == 0 || strlen(passphrase->valuestring) >= 8) &&
        strlen(passphrase->valuestring) < sizeof(candidate.passphrase) &&
        cJSON_IsNumber(channel) && channel->valuedouble >= 1 &&
        channel->valuedouble <= UINT8_MAX && channel->valuedouble == channel->valueint;

    const bool has_latitude = cJSON_IsNumber(latitude);
    const bool has_longitude = cJSON_IsNumber(longitude);
    if (valid && has_latitude != has_longitude) {
        valid = false;
    }
    if (valid && has_latitude) {
        candidate.latitude = latitude->valuedouble;
        candidate.longitude = longitude->valuedouble;
        candidate.has_location = isfinite(candidate.latitude) &&
            isfinite(candidate.longitude) &&
            candidate.latitude >= -90.0 && candidate.latitude <= 90.0 &&
            candidate.longitude >= -180.0 && candidate.longitude <= 180.0;
        valid = candidate.has_location;
    }

    uint32_t frequency_khz = 0;
    uint8_t bandwidth_mhz = 0;
    if (valid) {
        strlcpy(candidate.passphrase, passphrase->valuestring, sizeof(candidate.passphrase));
        candidate.channel = (uint8_t)channel->valueint;
        valid = halow_provisioning_resolve_channel(candidate.country,
                                                   candidate.channel,
                                                   &frequency_khz,
                                                   &bandwidth_mhz) == ESP_OK;
    }

    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (valid) {
        err = save_config(&candidate);
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG,
                 "Accepted mesh '%s', country %s, channel %u (%" PRIu32 " kHz/%u MHz), location=%u",
                 candidate.mesh_id, candidate.country, candidate.channel,
                 frequency_khz, bandwidth_mhz,
                 candidate.has_location ? 1U : 0U);
        restart_after_stop = true;
        if (xTaskCreate(stop_and_restart_task, "prov_stop", 3072, NULL, 5, NULL) != pdPASS) {
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
        nvs_get_u8(handle, "channel", &config->channel) == ESP_OK &&
        load_string(handle, "deviceUuid", config->client_id,
                    sizeof(config->client_id)) && valid_uuid(config->client_id);
    uint8_t has_location = 0U;
    if (nvs_get_u8(handle, "hasLocation", &has_location) == ESP_OK &&
        has_location != 0U) {
        size_t latitude_size = sizeof(config->latitude);
        size_t longitude_size = sizeof(config->longitude);
        config->has_location =
            nvs_get_blob(handle, "latitude", &config->latitude,
                         &latitude_size) == ESP_OK &&
            latitude_size == sizeof(config->latitude) &&
            nvs_get_blob(handle, "longitude", &config->longitude,
                         &longitude_size) == ESP_OK &&
            longitude_size == sizeof(config->longitude) &&
            isfinite(config->latitude) && isfinite(config->longitude) &&
            config->latitude >= -90.0 && config->latitude <= 90.0 &&
            config->longitude >= -180.0 && config->longitude <= 180.0;
    }
    nvs_close(handle);

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
    snprintf(service_name, sizeof(service_name), "EZ_%02X%02X%02X%02X%02X%02X",
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
    if (err == ESP_OK) {
        err = network_prov_mgr_endpoint_create(HALOW_PROVISIONING_ENDPOINT);
    }
    if (err == ESP_OK) {
        err = network_prov_scheme_ble_set_service_uuid(
            edgez_provisioning_service_uuid);
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
