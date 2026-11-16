/* Local HT-HC33 association/DHCP/UDP test using official Morse station APIs. */
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs_flash.h"
#include "mmhalow.h"

static const char *TAG = "hc33_ap_test";
static EventGroupHandle_t events;
#define ASSOCIATED BIT0
#define GOT_IP BIT1

static void station_status(enum mmwlan_sta_state state)
{
    ESP_LOGI(TAG, "HaLow station state=%d", state);
    if (state == MMWLAN_STA_CONNECTED) xEventGroupSetBits(events, ASSOCIATED);
    else xEventGroupClearBits(events, ASSOCIATED | GOT_IP);
}

static void got_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    ip_event_got_ip_t *event = data;
    ESP_LOGI(TAG, "DHCP PASS address=" IPSTR, IP2STR(&event->ip_info.ip));
    xEventGroupSetBits(events, GOT_IP);
}

static void echo_test(void)
{
    struct sockaddr_in peer = {.sin_family=AF_INET, .sin_port=htons(4242)};
    inet_pton(AF_INET, "10.83.0.1", &peer.sin_addr);
    int fd=socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if(fd<0) { ESP_LOGE(TAG,"socket errno=%d",errno); return; }
    struct timeval timeout={.tv_sec=3};
    setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    if(connect(fd,(struct sockaddr *)&peer,sizeof(peer))<0) { close(fd); return; }
    unsigned seq=0;
    while ((xEventGroupGetBits(events)&(ASSOCIATED|GOT_IP)) == (ASSOCIATED|GOT_IP)) {
        char message[80], reply[80];
        int len=snprintf(message,sizeof(message),"edgez-halow-test seq=%u",++seq);
        if(send(fd,message,len,0)==len) {
            int count=recv(fd,reply,sizeof(reply),0);
            if(count==len && memcmp(reply,message,len)==0)
                ESP_LOGI(TAG,"LOCAL ECHO PASS seq=%u bytes=%d",seq,count);
            else ESP_LOGW(TAG,"Echo timeout/mismatch seq=%u bytes=%d",seq,count);
        } else ESP_LOGW(TAG,"send errno=%d",errno);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    close(fd);
}

void app_main(void)
{
    /* Do not erase NVS/factory data if an existing partition is incompatible. */
    ESP_ERROR_CHECK(nvs_flash_init());
    events=xEventGroupCreate();
    assert(events);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,got_ip,NULL));
    ESP_LOGI(TAG,"Official Morse AP test: SSID=%s region=US peer=10.83.0.1:4242",
             CONFIG_OFFGRID_AP_TEST_SSID);
    ESP_ERROR_CHECK(mmhalow_init(NULL));
    mmhalow_print_version_info();
    uint8_t mac[6];
    if(mmwlan_get_vif_mac_addr(MMWLAN_VIF_STA,mac)==MMWLAN_SUCCESS)
        ESP_LOGI(TAG,"HaLow MAC=%02x:%02x:%02x:%02x:%02x:%02x",
                 mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    mmhalow_wifi_config_t config={.sta=MMWLAN_STA_ARGS_INIT};
    size_t ssid_len=strlen(CONFIG_OFFGRID_AP_TEST_SSID), key_len=strlen(CONFIG_OFFGRID_AP_TEST_PSK);
    assert(ssid_len<=sizeof(config.sta.ssid) && key_len>=8 && key_len<=sizeof(config.sta.passphrase));
    memcpy(config.sta.ssid,CONFIG_OFFGRID_AP_TEST_SSID,ssid_len);
    config.sta.ssid_len=ssid_len;
    memcpy(config.sta.passphrase,CONFIG_OFFGRID_AP_TEST_PSK,key_len);
    config.sta.passphrase_len=key_len;
    config.sta.security_type=MMWLAN_SAE;
    ESP_ERROR_CHECK(mmhalow_set_config(WIFI_IF_STA,&config));
    for(;;) {
        xEventGroupClearBits(events,ASSOCIATED|GOT_IP);
        if(mmhalow_connect(station_status)==ESP_OK) {
            EventBits_t bits=xEventGroupWaitBits(events,ASSOCIATED|GOT_IP,pdFALSE,pdTRUE,pdMS_TO_TICKS(120000));
            if((bits&(ASSOCIATED|GOT_IP))==(ASSOCIATED|GOT_IP)) echo_test();
            else ESP_LOGW(TAG,"Association/DHCP timeout bits=0x%x",(unsigned)bits);
        }
        mmhalow_disconnect();
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
