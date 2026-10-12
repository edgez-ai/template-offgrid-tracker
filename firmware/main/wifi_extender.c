#include "wifi_extender.h"
#include "wifi_extender_adapter.h"
#include "edgez_mesh_alfred.h"
#include "edgez_mesh_internet.h"
#include "dhcpserver/dhcpserver.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "lwip/ip4_addr.h"
#if CONFIG_IDF_TARGET_ESP32P4
#include "esp_hosted.h"
#endif
#include <stdio.h>
#include <string.h>

static const char *TAG = "wifi_extender";
static uint8_t radio_mac[6];
static bool gateway_mode;
static bool started;
static esp_netif_t *upstream_netif;

bool wifi_extender_is_gateway(void) { return gateway_mode; }

bool wifi_extender_get_mac(uint8_t mac[6])
{
    memcpy(mac, radio_mac, sizeof(radio_mac));
    return true; /* Set before any forwarding worker is created. */
}

static void receive_frame(const uint8_t originator[6], const uint8_t *frame,
                          size_t length, void *arg)
{
    (void)arg;
    if (!edgez_mesh_internet_handle_frame(frame, length)) {
        edgez_mesh_alfred_handle_frame(originator, frame, length);
    }
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        edgez_mesh_internet_wifi_upstream_changed(false);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = data;
        if (event->esp_netif == upstream_netif)
            edgez_mesh_internet_wifi_upstream_changed(true);
    }
}

static esp_err_t configure_softap(esp_netif_t *netif)
{
    uint8_t mac[6];
    esp_err_t err = esp_wifi_get_mac(WIFI_IF_AP, mac);
    if (err != ESP_OK) return err;
    wifi_config_t config = {0};
    snprintf((char *)config.ap.ssid, sizeof(config.ap.ssid),
             "EZ-%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    const size_t password_len = strlen(CONFIG_DAB_WIFI_EXTENDER_PASSWORD);
    if (password_len < 8 || password_len > 63) return ESP_ERR_INVALID_ARG;
    strlcpy((char *)config.ap.password, CONFIG_DAB_WIFI_EXTENDER_PASSWORD,
            sizeof(config.ap.password));
    config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    config.ap.channel = 1;
    config.ap.max_connection = 10;
    config.ap.ssid_len = strlen((char *)config.ap.ssid);

    /* Same deterministic /27 allocation as the reference extender. */
    uint32_t hash = 2166136261U;
    for (size_t i = 0; i < sizeof(mac); ++i) hash = (hash ^ mac[i]) * 16777619U;
    esp_netif_ip_info_t ip = {0};
    IP4_ADDR(&ip.ip, 10, 80U + ((hash >> 11) & 15U),
                 (hash >> 3) & 255U, (hash & 7U) * 32U + 1U);
    IP4_ADDR(&ip.netmask, 255, 255, 255, 224);
    ip.gw = ip.ip;
    err = esp_netif_dhcps_stop(netif);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) return err;
    err = esp_netif_set_ip_info(netif, &ip);
    if (err != ESP_OK) return err;
    dhcps_lease_t lease = {.enable = true};
    lease.start_ip.addr = htonl(ntohl(ip.ip.addr) + 1);
    lease.end_ip.addr = htonl(ntohl(ip.ip.addr) + 15);
    err = esp_netif_dhcps_option(netif, ESP_NETIF_OP_SET,
                                 ESP_NETIF_REQUESTED_IP_ADDRESS, &lease, sizeof(lease));
    if (err != ESP_OK) return err;
    err = esp_netif_dhcps_start(netif);
    if (err != ESP_OK) return err;
    err = esp_wifi_set_config(WIFI_IF_AP, &config);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Downstream SSID=%s router=" IPSTR "/27",
                 config.ap.ssid, IP2STR(&ip.ip));
    }
    return err;
}

esp_err_t wifi_extender_start(const uint8_t mesh_mac[6], bool gateway)
{
    if (started) return ESP_ERR_INVALID_STATE;
    memcpy(radio_mac, mesh_mac, sizeof(radio_mac));
    gateway_mode = gateway;
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) return err;
#if CONFIG_IDF_TARGET_ESP32P4
    /* A provisioned boot still needs the C6 for native Wi-Fi. */
    err = esp_hosted_init();
    if (err != ESP_OK) return err;
    err = esp_hosted_slave_reset();
    if (err != ESP_OK) return err;
#endif
    esp_netif_t *netif = gateway ? esp_netif_create_default_wifi_sta()
                                 : esp_netif_create_default_wifi_ap();
    if (!netif) return ESP_ERR_NO_MEM;
    if (gateway) upstream_netif = netif;
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&init);
    if (err != ESP_OK) return err;
    err = esp_wifi_set_mode(gateway ? WIFI_MODE_STA : WIFI_MODE_AP);
    if (err != ESP_OK) return err;
    if (gateway) {
        wifi_config_t saved = {0};
        err = esp_wifi_get_config(WIFI_IF_STA, &saved);
        if (err != ESP_OK) return err;
        if (!saved.sta.ssid[0]) {
            ESP_LOGE(TAG, "Wi-Fi gateway needs saved upstream credentials; reprovision the device");
            return ESP_ERR_INVALID_STATE;
        }
        err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL);
        if (err != ESP_OK) return err;
        err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL);
    } else {
        err = configure_softap(netif);
    }
    if (err != ESP_OK) return err;
    err = gateway ? edgez_mesh_internet_start_gateway(netif)
                  : edgez_mesh_internet_start(netif);
    if (err != ESP_OK) return err;
    edgez_mesh_register_network_cb(receive_frame, NULL);
    err = esp_wifi_start();
    if (err != ESP_OK) return err;
    started = true;
    ESP_LOGI(TAG, "%s started", gateway ? "Wi-Fi upstream gateway" : "HaLow Wi-Fi extender");
    return ESP_OK;
}
