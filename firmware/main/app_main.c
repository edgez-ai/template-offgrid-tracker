#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "edgez_halow_mesh_service.h"
#include "halow_pawr.h"
#include "halow_provisioning.h"
#if CONFIG_HALOW_BLE_PROVISIONING
esp_err_t edgez_ble_control_start(void);
void edgez_ble_control_set_radio_profile(const char *country_code,
                                         const char *mesh_id,
                                         const char *passphrase,
                                         uint32_t frequency_khz,
                                         uint8_t bandwidth_mhz);
void edgez_ble_control_note_mesh_started(const uint8_t mac[6]);
void edgez_ble_control_note_mesh_link(int state);
#if CONFIG_DAB_START_NETWORK_PACKET_RELAY
void edgez_ble_control_receive_mesh_packet(const uint8_t *payload,
                                            size_t length,
                                            void *arg);
#endif
esp_err_t edgez_ble_control_wait_for_mesh_init(char country_code[3],
                                               char mesh_id[33],
                                               char passphrase[65],
                                               uint32_t *frequency_khz,
                                               uint8_t *bandwidth_mhz);
#endif
#if CONFIG_OFFGRID_MESH_PS_TEST
#include "mesh_ps_test.h"
#endif
#if CONFIG_DAB_WIFI_EXTENDER
#include "wifi_extender.h"
#endif

#if CONFIG_DAB_FACTORY_RESET_BUTTON
#include "factory_reset_button.h"
#endif

#if CONFIG_DAB_START_MQTT_RELAY || CONFIG_DAB_START_NETWORK_PACKET_RELAY
#include "edgez_mqtt.hpp"
#endif
#if CONFIG_DAB_START_MQTT_RELAY
#include "halow_telemetry.h"
#endif

#if CONFIG_IDF_TARGET_ESP32P4 && CONFIG_HALOW_BLE_PROVISIONING
#include "esp_hosted.h"

#if !CONFIG_ESP_HOSTED_SDIO_HOST_INTERFACE
#error "ESP32-P4 BLE provisioning requires CONFIG_ESP_HOSTED_SDIO_HOST_INTERFACE"
#endif
#endif

#include <stdio.h>
#include <string.h>

static const char *TAG = "halow";

#if CONFIG_IDF_TARGET_ESP32P4 && CONFIG_HALOW_BLE_PROVISIONING
/* ESP-IDF 5.5's NimBLE host calls this teardown hook. ESP-Hosted 1.4's VHCI
 * transport predates the hook and has no controller-side teardown to do. */
void ble_transport_ll_deinit(void)
{
}
#endif

#if CONFIG_HALOW_BLE_PROVISIONING
static halow_provisioning_config_t provisioned_config;
#endif

#if CONFIG_HALOW_PAWR_ENABLE
static void pawr_beacon_callback(const uint8_t source_mac[6],
                                 const uint8_t *beacon,
                                 size_t length,
                                 int16_t rssi_dbm,
                                 void *arg)
{
    (void)arg;
    ESP_LOGI(TAG,
             "PAwR beacon from %02x:%02x:%02x:%02x:%02x:%02x, RSSI=%d dBm, bytes=%u",
             source_mac[0], source_mac[1], source_mac[2], source_mac[3],
             source_mac[4], source_mac[5], (int)rssi_dbm, (unsigned)length);
    const esp_err_t err = halow_pawr_ack_beacon(source_mac, beacon, length);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "PAwR acknowledgement failed: %s", esp_err_to_name(err));
    }
#if CONFIG_DAB_START_MQTT_RELAY
    const esp_err_t telemetry_err = halow_telemetry_forward_beacon(beacon, length);
    if (telemetry_err != ESP_OK && telemetry_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "PAwR telemetry forwarding failed: %s",
                 esp_err_to_name(telemetry_err));
    }
#endif
}
#endif

#if CONFIG_HALOW_MESH_AUTO_JOIN
static void mesh_status_callback(edgez_halow_link_state_t state)
{
#if CONFIG_HALOW_BLE_PROVISIONING
    edgez_ble_control_note_mesh_link((int)state);
#endif
#if CONFIG_OFFGRID_MESH_PS_TEST
    mesh_ps_test_notify_link(state == EDGEZ_HALOW_LINK_CONNECTED);
#endif
    switch (state) {
        case EDGEZ_HALOW_LINK_DISABLED:
            ESP_LOGW(TAG, "HaLow mesh interface disabled");
            break;
        case EDGEZ_HALOW_LINK_CONNECTING:
            ESP_LOGI(TAG, "Discovering/admitting HaLow mesh peers");
            break;
        case EDGEZ_HALOW_LINK_CONNECTED:
            ESP_LOGI(TAG, "HaLow mesh peer link established");
            break;
        default:
            ESP_LOGW(TAG, "Unknown HaLow mesh state: %d", (int)state);
            break;
    }
}

#if CONFIG_DAB_START_MQTT_RELAY
static int relay_publish(const char *topic,
                         const void *payload,
                         size_t length,
                         int qos,
                         bool retain,
                         void *arg)
{
    (void)arg;
    if (strcmp(topic, "system/status") == 0) {
        return edgez_mqtt_publish_system_status(payload, length, qos, retain);
    }
    if (strcmp(topic, "telemetry/sensors") == 0) {
        return edgez_mqtt_publish_telemetry(payload, length, qos, retain);
    }
    return -1;
}

static bool relay_ready(void *arg)
{
    (void)arg;
    return edgez_mqtt_gateway_available();
}
#endif

static esp_err_t start_mesh(void)
{
    esp_err_t err;
#if CONFIG_HALOW_BLE_PROVISIONING
    const char *country_code = provisioned_config.country;
    const char *mesh_id = provisioned_config.mesh_id;
    const char *passphrase = provisioned_config.passphrase;
    uint32_t mesh_frequency_khz = 0;
    uint8_t mesh_bandwidth_mhz = 0;
    char realtime_country_code[3] = {0};
    char realtime_mesh_id[33] = {0};
    char realtime_passphrase[65] = {0};
    ESP_LOGI(TAG, "Realtime BLE ready; waiting for app INIT_HALOW");
    err = edgez_ble_control_wait_for_mesh_init(realtime_country_code,
                                               realtime_mesh_id,
                                               realtime_passphrase,
                                               &mesh_frequency_khz,
                                               &mesh_bandwidth_mhz);
    if (err != ESP_OK) {
        return err;
    }
    country_code = realtime_country_code;
    mesh_id = realtime_mesh_id;
    passphrase = realtime_passphrase;
    if (mesh_frequency_khz == 0 || mesh_bandwidth_mhz == 0) {
        err = halow_provisioning_resolve_channel(provisioned_config.country,
                                                  provisioned_config.channel,
                                                  &mesh_frequency_khz,
                                                  &mesh_bandwidth_mhz);
        if (err != ESP_OK) {
            return err;
        }
    }
#else
    const char *country_code = CONFIG_HALOW_COUNTRY_CODE;
    const char *mesh_id = CONFIG_HALOW_MESH_ID;
    const char *passphrase = CONFIG_HALOW_MESH_PASSPHRASE;
    const uint32_t mesh_frequency_khz = CONFIG_HALOW_MESH_FREQUENCY_KHZ;
    const uint8_t mesh_bandwidth_mhz = CONFIG_HALOW_MESH_BANDWIDTH_MHZ;
#endif
    edgez_halow_mesh_service_config_t service_config =
        EDGEZ_HALOW_MESH_SERVICE_CONFIG_INIT;
    service_config.country_code = country_code;
    service_config.mesh_id = mesh_id;
    service_config.passphrase = passphrase;
    service_config.frequency_khz = mesh_frequency_khz;
    service_config.bandwidth_mhz = mesh_bandwidth_mhz;
    service_config.scan_dwell_ms = CONFIG_HALOW_MESH_SCAN_DWELL_MS;
    service_config.scan_initial_delay_ms =
        CONFIG_HALOW_MESH_SCAN_INTERVAL_BASE_S * 1000U;
    service_config.scan_initial_interval_ms =
        CONFIG_HALOW_MESH_SCAN_INTERVAL_BASE_S * 1000U;
    service_config.scan_connected_interval_ms =
        CONFIG_HALOW_MESH_SCAN_INTERVAL_LIMIT_S * 1000U;
    service_config.status_cb = mesh_status_callback;
    ESP_LOGI(TAG,
             "Starting mesh from realtime profile: country='%s' mesh='%s' "
             "passphrase_len=%u frequency_khz=%lu bandwidth_mhz=%u",
             service_config.country_code, service_config.mesh_id,
             (unsigned)strlen(service_config.passphrase),
             (unsigned long)service_config.frequency_khz,
             (unsigned)service_config.bandwidth_mhz);
#if CONFIG_DAB_START_BATMAN
    service_config.enable_batman = true;
    service_config.batman_originator_interval_ms =
        CONFIG_HALOW_EDGEZ_BATMAN_INTERVAL_MS;
#elif CONFIG_OFFGRID_MESH_PS_TEST
    /* Peers may send BATMAN frames even though this test does not exercise the
     * routed data plane. Initialize its RX queues to consume those frames, but
     * minimize locally generated traffic during the power measurement. */
    service_config.enable_batman = true;
    service_config.batman_originator_interval_ms = 60000U;
#endif
#if CONFIG_HALOW_BLE_PROVISIONING
    edgez_ble_control_set_radio_profile(service_config.country_code,
                                         mesh_id, passphrase,
                                         mesh_frequency_khz,
                                         mesh_bandwidth_mhz);
#endif

    edgez_halow_mesh_service_info_t service_info = {0};
    err = edgez_halow_mesh_service_start(&service_config, &service_info);
    if (err != ESP_OK) {
        return err;
    }
#if CONFIG_HALOW_BLE_PROVISIONING
    edgez_ble_control_note_mesh_started(service_info.mac);
#endif

#if CONFIG_OFFGRID_MESH_PS_TEST
    err = mesh_ps_test_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not start HT-HC33 mesh power test: %s",
                 esp_err_to_name(err));
        return err;
    }
#endif

#if CONFIG_DAB_START_MQTT_RELAY || CONFIG_DAB_START_NETWORK_PACKET_RELAY
    char device_serial[13] = {0};
    snprintf(device_serial, sizeof(device_serial),
             "%02x%02x%02x%02x%02x%02x",
             service_info.mac[0], service_info.mac[1], service_info.mac[2],
             service_info.mac[3], service_info.mac[4], service_info.mac[5]);
#if CONFIG_HALOW_BLE_PROVISIONING
    const bool mqtt_gateway = false;
#else
    const bool mqtt_gateway = false;
#endif
    err = edgez_mqtt_init(mqtt_gateway, device_serial, NULL, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not start BATMAN MQTT relay: %s",
                 esp_err_to_name(err));
        return err;
    }
    edgez_mqtt_set_local_mac(service_info.mac);
#if CONFIG_DAB_START_NETWORK_PACKET_RELAY
    edgez_mqtt_register_network_packet_cb(
        edgez_ble_control_receive_mesh_packet, NULL);
    ESP_LOGI(TAG,
             "Unified NetworkPacket L2 relay ready (kind=2, broadcast/unicast)");
#endif
#if CONFIG_DAB_START_MQTT_RELAY
    if (mqtt_gateway) {
        ESP_LOGI(TAG,
                 "BATMAN-IV + MQTT relay ready as gateway; advertisement starts when MQTT is online");
    } else {
        ESP_LOGI(TAG,
                 "BATMAN-IV + MQTT relay ready as leaf; waiting for gateway advertisement");
    }
#endif
#if CONFIG_DAB_START_MQTT_RELAY && CONFIG_HALOW_BLE_PROVISIONING
    if (provisioned_config.client_id[0] != '\0') {
        err = halow_telemetry_start_local(provisioned_config.client_id,
                                          service_info.mac,
                                          provisioned_config.channel,
                                          mesh_frequency_khz,
                                          mesh_bandwidth_mhz,
                                          CONFIG_DAB_PUBLISH_SYSTEM_STATUS,
                                          true,
                                          relay_publish,
                                          relay_ready,
                                          NULL);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Could not start local cloud reporting: %s",
                     esp_err_to_name(err));
            return err;
        }
    } else {
        ESP_LOGW(TAG,
                 "Provisioned MQTT clientId is missing; local cloud reporting disabled until reprovisioned");
    }
#elif CONFIG_DAB_START_MQTT_RELAY
    ESP_LOGW(TAG,
             "Local cloud reporting requires a provisioned Appwrite clientId");
#endif
#endif
#if CONFIG_DAB_WIFI_EXTENDER
#if CONFIG_HALOW_BLE_PROVISIONING
    err = wifi_extender_start(service_info.mac, false);
#else
    err = wifi_extender_start(service_info.mac, false);
#endif
    if (err != ESP_OK) return err;
#endif
#if CONFIG_HALOW_PAWR_ENABLE
    err = halow_pawr_start(pawr_beacon_callback, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not start HaLow PAwR bridge: %s", esp_err_to_name(err));
        return err;
    }
#endif
    return ESP_OK;
}
#endif

static void halow_init_task(void *arg)
{
    (void)arg;
#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "Starting Morse Micro HaLow stack with MM6108 SPI transport");
#else
    ESP_LOGI(TAG, "Starting Morse Micro HaLow stack with MM8108 USB transport");
#endif
#if CONFIG_HALOW_MESH_AUTO_JOIN
#if CONFIG_HALOW_BLE_PROVISIONING
    esp_err_t mesh_err;
    while (true) {
        mesh_err = start_mesh();
        if (mesh_err == ESP_OK) {
            break;
        }
        ESP_LOGE(TAG, "Failed to start HaLow mesh: %s (%d)",
                 esp_err_to_name(mesh_err), (int)mesh_err);
        ESP_LOGI(TAG, "Waiting for another realtime INIT_HALOW request");
    }
#else
    const esp_err_t mesh_err = start_mesh();
    if (mesh_err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start HaLow mesh: %s (%d)",
                 esp_err_to_name(mesh_err), (int)mesh_err);
    }
#endif
#endif
    vTaskDelete(NULL);
}

void app_main(void)
{
#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "ESP32-S3 Morse Micro MM6108 Wi-Fi HaLow mesh + PAwR");
#else
    ESP_LOGI(TAG, "ESP32-P4 Morse Micro MM8108 Wi-Fi HaLow USB bring-up");
#endif
#if CONFIG_DAB_FACTORY_RESET_BUTTON
    ESP_ERROR_CHECK(factory_reset_button_handle_pending());
    ESP_ERROR_CHECK(factory_reset_button_start());
#endif
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

#if CONFIG_HALOW_BLE_PROVISIONING
    bool provisioned = false;
    ESP_ERROR_CHECK(halow_provisioning_init(&provisioned_config, &provisioned));
    if (!provisioned) {
        ESP_LOGI(TAG,
                 "No saved HaLow profile; starting realtime BLE and waiting for INIT_HALOW");
    } else {
        ESP_LOGI(TAG, "Saved mesh profile '%s', country %s, channel %u available",
                 provisioned_config.mesh_id, provisioned_config.country,
                 provisioned_config.channel);
    }
#if CONFIG_IDF_TARGET_ESP32P4
    ESP_LOGI(TAG, "Starting ESP-Hosted transport for realtime BLE control");
    ESP_ERROR_CHECK(esp_hosted_init());
    ESP_ERROR_CHECK(esp_hosted_slave_reset());
#endif
    ESP_ERROR_CHECK(edgez_ble_control_start());
#endif

    const BaseType_t created = xTaskCreate(halow_init_task,
                                           "halow_init",
                                           CONFIG_HALOW_INIT_TASK_STACK_SIZE,
                                           NULL,
                                           CONFIG_HALOW_INIT_TASK_PRIORITY,
                                           NULL);
    ESP_ERROR_CHECK(created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);

#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "HaLow initialization task started; waiting for MM6108 SPI boot");
#else
    ESP_LOGI(TAG, "HaLow initialization task started; waiting for MM8108 on USB-A port 1");
#endif
}
