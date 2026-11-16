#include <zephyr/autoconf.h>
#if defined(CONFIG_OFFGRID_NRF54_AP_TEST)
/* Local HaLow AP integration test for the tracker FGH200M carrier. */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/net/dhcpv4.h>
#include <zephyr/net/net_event.h>
#include <zephyr/net/net_if.h>
#include <zephyr/net/net_mgmt.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/wifi_mgmt.h>
#include <zephyr/sys/atomic.h>
#include "ap_test_credentials.h"

LOG_MODULE_REGISTER(halow_ap_test, LOG_LEVEL_INF);
K_SEM_DEFINE(connect_result, 0, 1);
static atomic_t connected;
static struct net_mgmt_event_callback wifi_cb;

static void wifi_event(struct net_mgmt_event_callback *cb, uint64_t event,
                       struct net_if *iface)
{
    ARG_UNUSED(iface);
    if (event == NET_EVENT_WIFI_CONNECT_RESULT) {
        const struct wifi_status *status = cb->info;
        bool ok = status && status->status == WIFI_STATUS_CONN_SUCCESS;
        atomic_set(&connected, ok);
        LOG_INF("AP association result=%d", status ? status->status : -1);
        k_sem_give(&connect_result);
    } else if (event == NET_EVENT_WIFI_DISCONNECT_RESULT) {
        atomic_clear(&connected);
        LOG_WRN("AP disconnected");
    }
}

static void echo_test(void)
{
    struct sockaddr_in peer = {.sin_family = AF_INET, .sin_port = htons(4242)};
    zsock_inet_pton(AF_INET, "10.83.0.1", &peer.sin_addr);
    int fd = zsock_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) {
        LOG_ERR("UDP socket failed errno=%d", errno);
        return;
    }
    struct timeval timeout = {.tv_sec = 3};
    if (zsock_setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
        zsock_connect(fd, (struct sockaddr *)&peer, sizeof(peer)) < 0) {
        LOG_ERR("UDP setup failed errno=%d", errno);
        zsock_close(fd);
        return;
    }
    uint32_t sequence = 0;
    while (atomic_get(&connected)) {
        char message[80], reply[80];
        int length = snprintf(message, sizeof(message), "edgez-halow-test seq=%u", ++sequence);
        if (zsock_send(fd, message, length, 0) != length) {
            LOG_WRN("UDP send failed errno=%d", errno);
        } else {
            int count = zsock_recv(fd, reply, sizeof(reply), 0);
            if (count == length && memcmp(reply, message, length) == 0) {
                LOG_INF("LOCAL ECHO PASS seq=%u bytes=%d", sequence, count);
            } else {
                LOG_WRN("Local echo missing/mismatched seq=%u received=%d errno=%d",
                        sequence, count, errno);
            }
        }
        k_sleep(K_SECONDS(5));
    }
    zsock_close(fd);
}

int main(void)
{
    LOG_INF("Jetson AP test: SSID=EdgeZ-HaLow region=EU peer=10.83.0.1:4242");
    net_mgmt_init_event_callback(&wifi_cb, wifi_event,
        NET_EVENT_WIFI_CONNECT_RESULT | NET_EVENT_WIFI_DISCONNECT_RESULT);
    net_mgmt_add_event_callback(&wifi_cb);
    struct net_if *iface = net_if_get_first_wifi();
    if (!iface) {
        LOG_ERR("No HaLow Wi-Fi interface; check module power and SPI wiring");
        return -ENODEV;
    }
    const struct net_linkaddr *mac = net_if_get_link_addr(iface);
    if (mac && mac->len == 6) {
        LOG_INF("Sensor HaLow MAC=%02x:%02x:%02x:%02x:%02x:%02x",
            mac->addr[0], mac->addr[1], mac->addr[2], mac->addr[3], mac->addr[4], mac->addr[5]);
    }
    for (;;) {
        k_sem_reset(&connect_result);
        struct wifi_connect_req_params request = {0};
        request.ssid = (const uint8_t *)"EdgeZ-HaLow";
        request.ssid_length = strlen((const char *)request.ssid);
        request.sae_password = (const uint8_t *)AP_TEST_PSK;
        request.sae_password_length = strlen(AP_TEST_PSK);
        request.security = WIFI_SECURITY_TYPE_SAE;
        request.mfp = WIFI_MFP_REQUIRED;
        request.channel = WIFI_CHANNEL_ANY;
        request.timeout = 120;
        int rc = net_mgmt(NET_REQUEST_WIFI_CONNECT, iface, &request, sizeof(request));
        if (rc == 0 && k_sem_take(&connect_result, K_SECONDS(125)) == 0 &&
            atomic_get(&connected)) {
            net_dhcpv4_start(iface);
            const struct in_addr *address = NULL;
            int64_t deadline = k_uptime_get() + 45000;
            while (atomic_get(&connected) && k_uptime_get() < deadline) {
                address = net_if_ipv4_get_global_addr(iface, NET_ADDR_PREFERRED);
                if (address) break;
                k_sleep(K_MSEC(500));
            }
            if (address) {
                char text[NET_IPV4_ADDR_LEN];
                net_addr_ntop(AF_INET, address, text, sizeof(text));
                LOG_INF("DHCP PASS address=%s", text);
                echo_test();
            } else {
                LOG_WRN("No DHCP address within 45 seconds");
            }
            net_dhcpv4_stop(iface);
        } else {
            LOG_WRN("Association failed/timed out request_rc=%d", rc);
        }
        net_mgmt(NET_REQUEST_WIFI_DISCONNECT, iface, NULL, 0);
        atomic_clear(&connected);
        k_sleep(K_SECONDS(10));
    }
    return 0;
}

#endif
