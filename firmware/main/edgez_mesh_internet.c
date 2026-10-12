/* Ported from edge-device-esp32-internal wifi-extender (3016950). */
#include "extender_dns.h"
#include "dhcpserver/dhcpserver_options.h"
#include "dhcpserver/dhcpserver.h"
#include "lwip/dns.h"
#include "edgez_mesh_internet.h"
#include "edgez_mesh_iperf.h"
#include "edgez_mesh_alfred.h"
#include "wifi_extender_adapter.h"
#include "edgez_pktmem_diag.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif_net_stack.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/dhcp.h"
#include "lwip/etharp.h"
#include "lwip/ip4.h"
#include "lwip/inet.h"
#include "lwip/lwip_napt.h"
#include "lwip/tcpip.h"
#include "netif/ethernet.h"
#include <stdlib.h>
#include <string.h>

#if CONFIG_DAB_WIFI_EXTENDER && CONFIG_HALOW_EDGEZ_BATMAN && IP_FORWARD && IP_NAPT

static bool gateway_mode;
static uint32_t ready_ip;
static dhcps_t *mesh_server;
static bool mesh_server_started;
static uint32_t gateway_upstream_ip;
static bool gateway_advertised;
uint32_t edgez_mesh_internet_ready_ip(void) { return __atomic_load_n(&ready_ip, __ATOMIC_ACQUIRE); }
bool edgez_mesh_internet_gateway_advertised(void)
{
    return __atomic_load_n(&gateway_advertised, __ATOMIC_ACQUIRE);
}

/* Match the working v2 relay. Linux batman-adv may fragment a full-size
 * Ethernet payload after adding its unicast header, so stay below that L2
 * fragmentation point. Clamp routed TCP in both directions to the same MTU. */
#define IP_MTU 1400
#define TCP_MSS_CLAMP (IP_MTU - 40)
#define ETH_MAX (IP_MTU + 14)
#define TX_QUEUE_DEPTH 16
#define TX_PRIORITY_QUEUE_DEPTH 16
#define TX_PRIORITY_BURST 4
#define TX_PRIORITY_TID 6
#define TX_PRIORITY_READY_TIMEOUT_MS 20
#define TX_BULK_READY_TIMEOUT_MS 0
#define TX_BULK_MAX_QUEUE_MS 200
#define RX_BULK_ACTIVE_MS 250
#define TX_RX_FAIRNESS_WAIT_MS 10
#define RX_QUEUE_DEPTH 32
#define TX_WORKER_STACK_SIZE 8192
#define RX_WORKER_STACK_SIZE 4096
#define HOT_PACKET_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define WORKER_STACK_CAPS (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define HOT_MEMORY_NAME "PSRAM"
static const char *TAG = "edgez_mesh_internet";
typedef struct {
    uint32_t generation;
    uint32_t tx_enqueued_ms;
    uint16_t len;
    bool rx, broadcast;
    uint8_t gateway[6];
    uint8_t data[];
} packet_t;
typedef struct {
    uint32_t count, queue_ms, queue_max_ms, submit_us, submit_max_us, failed;
    int last_error;
} tx_diag_t;
typedef struct {
    struct netif mesh;
    struct dhcp dhcp;
    esp_netif_t *ap;
    netif_linkoutput_fn ap_linkoutput;
    bool added, nat, dhcp_started, ready;
    edgez_mesh_gateway_record_t gateway;
    uint8_t self[6];
    uint32_t generation;
    uint32_t last_arp_ms;
    uint32_t last_ip;
    uint32_t last_memory_warning_ms;
    uint32_t last_status_ms;
    uint32_t tx_queued, tx_sent, tx_failed, tx_dropped;
    uint32_t rx_seen, rx_queued, rx_delivered;
    uint32_t tx_bytes_queued, tx_bytes_sent, rx_bytes_seen, rx_bytes_delivered;
    uint32_t tx_queue_high_water, rx_queue_high_water;
    uint32_t tx_priority_queued, tx_priority_dropped, tx_priority_coalesced;
    uint32_t tx_stale_bulk_dropped;
    uint32_t tx_priority_high_water;
    uint32_t last_rx_bulk_ms, tx_rx_fairness_waits;
    uint32_t tx_submit_us, tx_submit_max_us;
    uint32_t rx_inject_us, rx_inject_max_us, rx_inject_calls;
    uint32_t rx_drop_state, rx_drop_mac, rx_drop_ip, rx_drop_memory, rx_input_error;
    uint32_t rx_bad_header, rx_wrong_dhcp, rx_wrong_destination;
    uint32_t rx_pbuf_alloc, rx_pbuf_copy, rx_callback_error;
    int rx_last_input_error, rx_last_callback_error, ap_last_error;
    tx_diag_t tx_diag[3]; /* pure TCP ACK, other priority, bulk */
    uint32_t ap_tx_ipv4, ap_tx_arp, ap_tx_other, ap_tx_error;
    uint32_t ap_mem_single, ap_mem_chain;
    uint32_t ap_fail_len, ap_fail_segments, ap_fail_internal, ap_fail_largest;
    uint32_t ap_memory_sample_ms;
    uint8_t softap_dns[4];
} internet_t;
static internet_t *s;
static QueueHandle_t tx_queue;
static QueueHandle_t tx_priority_queue;
static portMUX_TYPE tx_priority_lock = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE tx_diag_lock = portMUX_INITIALIZER_UNLOCKED;
static packet_t *tx_queued_acks[TX_PRIORITY_QUEUE_DEPTH];
static QueueHandle_t rx_queue;
static TaskHandle_t tx_worker_task;
static TaskHandle_t rx_worker_task;
static uint32_t generation;
static bool accepting_packets;


static uint32_t now_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
static uint16_t be16(const uint8_t *p) { return ((uint16_t)p[0] << 8) | p[1]; }

static void *hot_calloc(size_t count, size_t size)
{
    return heap_caps_calloc(count, size, HOT_PACKET_CAPS);
}

static BaseType_t create_worker(TaskFunction_t entry, const char *name,
                                uint32_t stack_size, void *arg,
                                UBaseType_t priority, TaskHandle_t *handle)
{
    return xTaskCreateWithCaps(entry, name, stack_size, arg,
                               priority, handle, WORKER_STACK_CAPS);
}

static void put_be16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value >> 8);
    p[1] = (uint8_t)value;
}

/* Adjust a one's-complement checksum after replacing one network-order
 * 16-bit word (RFC 1624). */
static uint16_t checksum_replace16(uint16_t checksum, uint16_t old_value,
                                   uint16_t new_value)
{
    uint32_t sum = (uint16_t)~checksum;
    sum += (uint16_t)~old_value;
    sum += new_value;
    sum = (sum & 0xffffU) + (sum >> 16);
    sum = (sum & 0xffffU) + (sum >> 16);
    return (uint16_t)~sum;
}

/* Clamp the MSS option on SYN and SYN-ACK packets crossing the mesh. Merely
 * lowering netif->mtu is insufficient for routed clients because their Wi-Fi
 * interface still advertises an MTU of 1500. */
static void clamp_tcp_mss(uint8_t *frame, size_t frame_len)
{
    if (!frame || frame_len < 14 + 20 + 20 || be16(frame + 12) != 0x0800 ||
        (frame[14] >> 4) != 4) return;

    uint8_t *ip = frame + 14;
    size_t ihl = (ip[0] & 15U) * 4U;
    uint16_t ip_len = be16(ip + 2);
    if (ihl < 20 || ip_len < ihl + 20 || 14U + ip_len > frame_len ||
        (be16(ip + 6) & 0x3fffU) || ip[9] != 6) return;

    uint8_t *tcp = ip + ihl;
    size_t tcp_hlen = (tcp[12] >> 4) * 4U;
    if (!(tcp[13] & 0x02U) || tcp_hlen < 20 || ihl + tcp_hlen > ip_len) return;

    size_t offset = 20;
    while (offset < tcp_hlen) {
        uint8_t kind = tcp[offset];
        if (kind == 0) break;
        if (kind == 1) { ++offset; continue; }
        if (offset + 1 >= tcp_hlen) break;
        uint8_t option_len = tcp[offset + 1];
        if (option_len < 2 || offset + option_len > tcp_hlen) break;
        if (kind == 2 && option_len == 4) {
            uint16_t old_mss = be16(tcp + offset + 2);
            if (old_mss > TCP_MSS_CLAMP) {
                uint16_t checksum = be16(tcp + 16);
                put_be16(tcp + offset + 2, TCP_MSS_CLAMP);
                put_be16(tcp + 16,
                         checksum_replace16(checksum, old_mss, TCP_MSS_CLAMP));
            }
            break;
        }
        offset += option_len;
    }
}

typedef struct {
    uint8_t src[4], dst[4];
    uint16_t src_port, dst_port;
} tcp_flow_t;

static void atomic_max_u32(uint32_t *value, uint32_t candidate)
{
    uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
    while (candidate > current &&
           !__atomic_compare_exchange_n(value, &current, candidate, false,
                                        __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
    }
}

static packet_t *new_packet(QueueHandle_t target_queue, size_t len)
{
    if (!__atomic_load_n(&accepting_packets, __ATOMIC_ACQUIRE) ||
        !target_queue || !uxQueueSpacesAvailable(target_queue)) return NULL;
    return hot_calloc(1, sizeof(packet_t) + len);
}

static bool tx_parse_pure_tcp_ack(const uint8_t *frame, size_t captured,
                                  size_t frame_len, tcp_flow_t *flow)
{
    if (!frame || captured < 54 || frame_len < 54 || be16(frame + 12) != 0x0800 ||
        (frame[14] >> 4) != 4) return false;
    const uint8_t *ip = frame + 14;
    size_t ihl = (ip[0] & 15U) * 4U;
    uint16_t ip_len = be16(ip + 2);
    if (ihl < 20 || captured < 14 + ihl + 20 || ip_len < ihl + 20 ||
        ip_len > frame_len - 14 || (be16(ip + 6) & 0x3fffU) || ip[9] != 6) return false;
    const uint8_t *tcp = ip + ihl;
    size_t tcp_hlen = (tcp[12] >> 4) * 4U;
    /* ACK must be set while SYN/FIN/RST are clear. PSH/ECN flags do not
     * change the cumulative ACK semantics of a header-only segment. */
    if (tcp_hlen < 20 || captured < 14 + ihl + tcp_hlen ||
        ip_len != ihl + tcp_hlen || (tcp[13] & 0x17U) != 0x10U) return false;
    if (flow) {
        memcpy(flow->src, ip + 12, sizeof(flow->src));
        memcpy(flow->dst, ip + 16, sizeof(flow->dst));
        flow->src_port = be16(tcp);
        flow->dst_port = be16(tcp + 2);
    }
    return true;
}

static bool tx_same_tcp_flow(const uint8_t *frame, size_t frame_len,
                             const tcp_flow_t *wanted)
{
    tcp_flow_t found;
    return tx_parse_pure_tcp_ack(frame, frame_len, frame_len, &found) &&
           !memcmp(&found, wanted, sizeof(found));
}

/* Preserve capacity for packets that make bulk flows progress. This parser is
 * deliberately conservative: malformed/truncated and fragmented IP remains
 * in the ordered bulk queue. */
static bool tx_is_priority_frame(const uint8_t *frame, size_t captured, size_t frame_len)
{
    if (!frame || captured < 14 || frame_len < 14) return false;
    uint16_t ethertype = be16(frame + 12);
    if (ethertype == 0x0806) return true; /* ARP */
    if (ethertype != 0x0800 || captured < 34 || (frame[14] >> 4) != 4) return false;

    size_t ihl = (frame[14] & 15U) * 4U;
    uint16_t ip_len = be16(frame + 16);
    if (ihl < 20 || captured < 14 + ihl || ip_len < ihl ||
        ip_len > frame_len - 14 || (be16(frame + 20) & 0x3fffU)) return false;

    uint8_t protocol = frame[23];
    if (protocol == 1) return true; /* ICMP */
    if (protocol == 17) {
        if (captured < 14 + ihl + 8 || ip_len < ihl + 8 || ip_len > 576) return false;
        const uint8_t *udp = frame + 14 + ihl;
        uint16_t src = be16(udp), dst = be16(udp + 2);
        return src == 53 || dst == 53 ||
               ((src == 67 || src == 68) && (dst == 67 || dst == 68));
    }
    if (protocol != 6 || captured < 14 + ihl + 20) return false;

    const uint8_t *tcp = frame + 14 + ihl;
    size_t tcp_hlen = (tcp[12] >> 4) * 4U;
    if (tcp_hlen < 20 || ip_len < ihl + tcp_hlen) return false;
    return ip_len == ihl + tcp_hlen || (tcp[13] & 0x07U); /* ACK-only/SYN/FIN/RST */
}

/* When saturated, a newer cumulative ACK for the same connection supersedes
 * the queued copy. The worker removes a pointer from this table before it
 * accesses the packet, so replacing its bytes cannot race transmission. */
static bool tx_try_coalesce_ack(const uint8_t *frame, size_t captured, size_t len,
                                uint32_t item_generation, const uint8_t gateway[6])
{
    tcp_flow_t flow;
    if (captured < len || uxQueueSpacesAvailable(tx_priority_queue) != 0 ||
        !tx_parse_pure_tcp_ack(frame, captured, len, &flow)) return false;
    bool replaced = false;
    portENTER_CRITICAL(&tx_priority_lock);
    for (size_t i = 0; i < TX_PRIORITY_QUEUE_DEPTH; ++i) {
        packet_t *queued = tx_queued_acks[i];
        if (queued && queued->len == len && queued->generation == item_generation &&
            !memcmp(queued->gateway, gateway, 6) &&
            tx_same_tcp_flow(queued->data, queued->len, &flow)) {
            memcpy(queued->data, frame, len);
            replaced = true;
            break;
        }
    }
    portEXIT_CRITICAL(&tx_priority_lock);
    if (replaced) {
        __atomic_add_fetch(&s->tx_priority_coalesced, 1, __ATOMIC_RELAXED);
    }
    return replaced;
}

static BaseType_t tx_priority_send(packet_t *item)
{
    tcp_flow_t flow;
    bool ack = tx_parse_pure_tcp_ack(item->data, item->len, item->len, &flow);
    BaseType_t result;
    portENTER_CRITICAL(&tx_priority_lock);
    result = xQueueSend(tx_priority_queue, &item, 0);
    if (result == pdTRUE && ack) {
        for (size_t i = 0; i < TX_PRIORITY_QUEUE_DEPTH; ++i) {
            if (!tx_queued_acks[i]) {
                tx_queued_acks[i] = item;
                break;
            }
        }
    }
    portEXIT_CRITICAL(&tx_priority_lock);
    return result;
}

static BaseType_t tx_priority_receive(packet_t **item)
{
    BaseType_t result;
    portENTER_CRITICAL(&tx_priority_lock);
    result = xQueueReceive(tx_priority_queue, item, 0);
    if (result == pdTRUE) {
        for (size_t i = 0; i < TX_PRIORITY_QUEUE_DEPTH; ++i) {
            if (tx_queued_acks[i] == *item) {
                tx_queued_acks[i] = NULL;
                break;
            }
        }
    }
    portEXIT_CRITICAL(&tx_priority_lock);
    return result;
}

/* Called only on lwIP. Radio transmission is deferred to a bounded PSRAM queue. */
static err_t link_output(struct netif *n, struct pbuf *p)
{
    (void)n;
    if (p->tot_len < 14 || p->tot_len > ETH_MAX) {
        __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
        return ERR_RTE;
    }
    uint8_t header[74];
    size_t captured = pbuf_copy_partial(p, header,
                                        p->tot_len < sizeof(header) ? p->tot_len : sizeof(header),
                                        0);
    if (!gateway_mode && !s->gateway.valid) {
        __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
        return ERR_RTE;
    }
    bool priority = tx_is_priority_frame(header, captured, p->tot_len);
    QueueHandle_t target_queue = priority ? tx_priority_queue : tx_queue;
    const uint8_t *route_mac = gateway_mode ? header : s->gateway.mac;
    if (priority && s->ready &&
        tx_try_coalesce_ack(header, captured, p->tot_len,
                            s->generation, route_mac)) {
        return ERR_OK;
    }
    packet_t *item = new_packet(target_queue, p->tot_len);
    if (!item) {
        __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
        if (priority) __atomic_add_fetch(&s->tx_priority_dropped, 1, __ATOMIC_RELAXED);
        return ERR_MEM;
    }
    item->len = p->tot_len;
    item->generation = s->generation;
    memcpy(item->gateway, route_mac, 6);
    pbuf_copy_partial(p, item->data, item->len, 0);
    clamp_tcp_mss(item->data, item->len);
    if (be16(item->data + 12) == 0x0800 && !s->ready) {
        if (item->len < 34) {
            __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
            free(item);
            return ERR_VAL;
        }
        const uint8_t *ip = item->data + 14;
        size_t ihl = (ip[0] & 15) * 4;
        bool dhcp = item->len >= 42 && ihl >= 20 && 14 + ihl + 8 <= item->len &&
                    ip[9] == 17 && be16(ip + ihl) == 68 && be16(ip + ihl + 2) == 67;
        if (!dhcp) {
            __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
            free(item);
            return ERR_RTE;
        }
    }
    /* ARP (including unicast replies) and DHCP broadcasts carry an originator
     * header. Linux can learn our Ethernet MAC for the reverse path. Ordinary
     * IP is a single standard BATMAN unicast to the selected originator. */
    item->broadcast = be16(item->data + 12) == 0x0806 || (item->data[0] & 1);
    item->tx_enqueued_ms = now_ms();
    const uint16_t queued_len = item->len; /* Worker owns item after enqueue. */
    BaseType_t queued = priority ? tx_priority_send(item) : xQueueSend(target_queue, &item, 0);
    if (queued != pdTRUE) {
        __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
        if (priority) __atomic_add_fetch(&s->tx_priority_dropped, 1, __ATOMIC_RELAXED);
        free(item);
        return ERR_MEM;
    }
    __atomic_add_fetch(&s->tx_queued, 1, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s->tx_bytes_queued, queued_len, __ATOMIC_RELAXED);
    if (priority) {
        __atomic_add_fetch(&s->tx_priority_queued, 1, __ATOMIC_RELAXED);
        atomic_max_u32(&s->tx_priority_high_water,
                       (uint32_t)uxQueueMessagesWaiting(tx_priority_queue));
    } else {
        atomic_max_u32(&s->tx_queue_high_water,
                       (uint32_t)uxQueueMessagesWaiting(tx_queue));
    }
    if (tx_worker_task) xTaskNotifyGive(tx_worker_task);
    return ERR_OK;
}

static err_t mesh_ip_output(struct netif *n, struct pbuf *p, const ip4_addr_t *destination)
{
    /* DHCP renewal may write its server's default router asynchronously.
     * Always use the selected EdgeZ Mesh Network IP, including between worker ticks. */
    if (!gateway_mode && s->gateway.valid) {
        ip4_addr_t gateway_ip;
        memcpy(&gateway_ip.addr, s->gateway.ip, 4);
        netif_set_gw(n, &gateway_ip);
    }
    return etharp_output(n, p, destination);
}

static err_t interface_init(struct netif *n)
{
    n->name[0] = 'o'; n->name[1] = 'm';
    n->mtu = IP_MTU;
    n->hwaddr_len = 6; memcpy(n->hwaddr, s->self, 6);
    n->output = mesh_ip_output;
    n->linkoutput = link_output;
    n->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_ETHARP | NETIF_FLAG_ETHERNET;
    return ERR_OK;
}

/* Observe the last hop without retaining packets behind Wi-Fi failures. */
static err_t softap_link_output(struct netif *n, struct pbuf *p)
{
    uint8_t type[2] = {0};
    if (p && p->tot_len >= 14 && pbuf_copy_partial(p, type, sizeof(type), 12) == sizeof(type)) {
        uint32_t *counter = be16(type) == 0x0800 ? &s->ap_tx_ipv4 :
                            be16(type) == 0x0806 ? &s->ap_tx_arp : &s->ap_tx_other;
        __atomic_add_fetch(counter, 1, __ATOMIC_RELAXED);
    } else {
        __atomic_add_fetch(&s->ap_tx_other, 1, __ATOMIC_RELAXED);
    }
    err_t err = s->ap_linkoutput ? s->ap_linkoutput(n, p) : ERR_IF;
    if (err != ERR_OK) {
        __atomic_add_fetch(&s->ap_tx_error, 1, __ATOMIC_RELAXED);
        __atomic_store_n(&s->ap_last_error, err, __ATOMIC_RELAXED);
        if (err == ERR_MEM && p) {
            __atomic_add_fetch(p->next ? &s->ap_mem_chain : &s->ap_mem_single,
                               1, __ATOMIC_RELAXED);
            /* This hook and the reporter run on lwIP. Heap inspection is
             * limited to once per second, and only after a send failure. */
            uint32_t now = now_ms();
            if (!s->ap_memory_sample_ms || now - s->ap_memory_sample_ms >= 1000) {
                s->ap_memory_sample_ms = now;
                s->ap_fail_len = p->tot_len;
                s->ap_fail_segments = pbuf_clen(p);
                const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
                s->ap_fail_internal = heap_caps_get_free_size(caps);
                s->ap_fail_largest = heap_caps_get_largest_free_block(caps);
            }
        }
    }
    return err;
}

static bool configure_softap_dns(const uint8_t address[4])
{
    if (!address[0] || !memcmp(s->softap_dns, address, sizeof(s->softap_dns))) return false;
    esp_netif_dns_info_t dns = {0};
    dns.ip.type = ESP_IPADDR_TYPE_V4;
    memcpy(&dns.ip.u_addr.ip4.addr, address, 4);
    uint8_t offer_dns = 2;
    esp_err_t stop = esp_netif_dhcps_stop(s->ap);
    esp_err_t option = esp_netif_dhcps_option(s->ap, ESP_NETIF_OP_SET,
                                               ESP_NETIF_DOMAIN_NAME_SERVER,
                                               &offer_dns, sizeof(offer_dns));
    esp_err_t set = esp_netif_set_dns_info(s->ap, ESP_NETIF_DNS_MAIN, &dns);
    esp_err_t start = esp_netif_dhcps_start(s->ap);
    if ((stop != ESP_OK && stop != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) ||
        option != ESP_OK || set != ESP_OK ||
        (start != ESP_OK && start != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED)) {
        ESP_LOGW(TAG, "SoftAP DNS update failed stop=%s option=%s set=%s start=%s",
                 esp_err_to_name(stop), esp_err_to_name(option), esp_err_to_name(set),
                 esp_err_to_name(start));
        return false;
    }
    memcpy(s->softap_dns, address, sizeof(s->softap_dns));
    ESP_LOGI(TAG, "SoftAP DNS changed to local relay %u.%u.%u.%u",
             address[0], address[1], address[2], address[3]);
    return true;
}

typedef struct {
    size_t route_count, gateway_count;
    edgez_mesh_gateway_record_t gateway;
    edgez_batadv_route_snapshot_t snapshots[EDGEZ_MESH_GATEWAY_LIMIT];
    edgez_mesh_gateway_route_t routes[EDGEZ_MESH_GATEWAY_LIMIT];
    uint8_t mac[6];
} update_t;

static void set_gateway_advertisement(bool active, const char *reason)
{
    bool previous = __atomic_exchange_n(&gateway_advertised, active,
                                        __ATOMIC_ACQ_REL);
    edgez_mesh_set_gateway(active);
    if (previous != active) {
        ESP_LOGW(TAG,
                 "NODE ROLE active=%s wifi_upstream=%s batman_gateway_advertise=%u reason=%s",
                 active ? "GATEWAY_ACTIVE" : "GATEWAY_SUSPENDED",
                 active ? "CONNECTED_WITH_IP" : "NOT_READY",
                 active ? 1U : 0U,
                 reason ? reason : "state change");
    }
}

static void gateway_stop(struct netif *upstream, const char *reason)
{
    s->ready = false;
    set_gateway_advertisement(false, reason);
    (void)extender_dns_update(&s->mesh, upstream, NULL, false);
    if (s->nat) { ip_napt_enable_no(s->mesh.num, 0); s->nat = false; }
    if (mesh_server_started) { dhcps_stop(mesh_server, &s->mesh); mesh_server_started = false; }
    gateway_upstream_ip = 0;
    __atomic_store_n(&ready_ip, 0, __ATOMIC_RELEASE);
}

static void mesh_lease_assigned(void *arg, uint8_t client_ip[4],
                                uint8_t client_mac[6])
{
    (void)arg;
    ESP_LOGW(TAG,
             "HaLow gateway DHCP lease client=%u.%u.%u.%u mac=%02x:%02x:%02x:%02x:%02x:%02x",
             client_ip[0], client_ip[1], client_ip[2], client_ip[3],
             client_mac[0], client_mac[1], client_mac[2], client_mac[3],
             client_mac[4], client_mac[5]);
}

static void apply_gateway_state(void *ctx)
{
    update_t *u = ctx;
    s->ready = false;
    struct netif *ap = esp_netif_get_netif_impl(s->ap);
    if (!gateway_mode && !s->ap_linkoutput && ap && ap->linkoutput) {
        s->ap_linkoutput = ap->linkoutput;
        ap->linkoutput = softap_link_output;
    }
    if (!s->added) {
        ip4_addr_t zero = {0};
        memcpy(s->self, u->mac, 6);
        /* Keep netif->state NULL for this raw lwIP interface. With
         * LWIP_ESP_NETIF_DATA=0, ESP-IDF's global netif callback interprets
         * every non-NULL state pointer as esp_netif_t. Passing our internet_t
         * here therefore makes the first DHCP address-change callback
         * dereference the wrong object and crash. This interface uses the
         * module singleton directly and does not need netif->state. */
        if (!netif_add(&s->mesh, &zero, &zero, &zero, NULL, interface_init, tcpip_input)) return;
        dhcp_set_struct(&s->mesh, &s->dhcp);
        netif_set_up(&s->mesh);
        netif_set_link_up(&s->mesh);
        s->added = true;
        if (!gateway_mode) {
            uint8_t mac[6];
            if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
                char hostname[32];
                snprintf(hostname, sizeof(hostname), "EZ-%02X%02X%02X%02X%02X%02X",
                         mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
                edgez_mesh_alfred_set_hostname(hostname);
                (void)esp_netif_set_hostname(s->ap, hostname);
            }
        }

    }
    if (gateway_mode) {
        bool up = ap && netif_is_up(ap) && netif_is_link_up(ap) &&
                  !ip4_addr_isany_val(*netif_ip4_addr(ap));
        if (!up) { gateway_stop(ap, "Wi-Fi link down or DHCP address missing"); return; }
        if (gateway_upstream_ip && gateway_upstream_ip != netif_ip4_addr(ap)->addr)
            gateway_stop(ap, "Wi-Fi DHCP address changed");
        ip4_addr_t local, mask;
        IP4_ADDR(&local, 10, 42, 0, 1); IP4_ADDR(&mask, 255, 255, 255, 0);
        /* Do not route between overlapping upstream/downstream subnets. */
        if (ip4_addr_net_eq(&local, netif_ip4_addr(ap), netif_ip4_netmask(ap))) {
            IP4_ADDR(&local, 10, 43, 0, 1);
            if (ip4_addr_net_eq(&local, netif_ip4_addr(ap), netif_ip4_netmask(ap))) {
                gateway_stop(ap, "upstream and downstream subnets overlap");
                return;
            }
        }
        if (s->nat && netif_ip4_addr(&s->mesh)->addr != local.addr)
            gateway_stop(ap, "downstream gateway address changed");
        if (!s->nat) {
            /* ESP-IDF's DHCP server reads netif->gw for DHCP option 3. The
             * downstream HaLow interface is the downstream router, so advertise
             * its own 10.42.0.1 address as the clients' default gateway. */
            netif_set_addr(&s->mesh, &local, &mask, &local);
            netif_set_link_up(&s->mesh);
            if (heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) < 32768) {
                gateway_stop(ap, "insufficient internal memory for NAPT");
                return;
            }
            s->nat = ip_napt_enable_netif(&s->mesh, 1) != 0;
            if (!s->nat) {
                ESP_LOGW(TAG, "HaLow gateway NAPT enable failed");
            }
        }
        if (!mesh_server) {
            mesh_server = dhcps_new();
            if (mesh_server &&
                dhcps_set_new_lease_cb(mesh_server, mesh_lease_assigned, NULL) != ERR_OK) {
                dhcps_delete(mesh_server);
                mesh_server = NULL;
            }
        }
        if (!mesh_server || !s->nat) {
            gateway_stop(ap, "downstream DHCP or NAPT unavailable");
            return;
        }
        const ip_addr_t *dns = dns_getserver(0);
        dhcps_dns_setserver(mesh_server, dns);
        dhcps_offer_t dns_offer = OFFER_DNS;
        dhcps_offer_t router_offer = OFFER_ROUTER;
        err_t dns_option = dhcps_set_option_info(mesh_server, DOMAIN_NAME_SERVER,
                                                 &dns_offer, sizeof(dns_offer));
        err_t router_option = dhcps_set_option_info(mesh_server, ROUTER_SOLICITATION_ADDRESS,
                                                    &router_offer, sizeof(router_offer));
        err_t mask_option = dhcps_set_option_info(mesh_server, SUBNET_MASK,
                                                  &mask, sizeof(mask));
        if (!mesh_server_started && dns_option == ERR_OK && router_option == ERR_OK &&
            mask_option == ERR_OK) {
            err_t dhcp_err = dhcps_start(mesh_server, &s->mesh, local);
            mesh_server_started = dhcp_err == ERR_OK;
            if (mesh_server_started) {
                ESP_LOGW(TAG, "HaLow gateway DHCP ready address=" IPSTR
                         " mask=" IPSTR " router=" IPSTR " upstream=" IPSTR,
                         IP2STR(&local), IP2STR(&mask), IP2STR(&local),
                         IP2STR(netif_ip4_addr(ap)));
            } else {
                ESP_LOGW(TAG, "HaLow gateway DHCP start failed err=%d", dhcp_err);
            }
        }
        if (dns_option != ERR_OK || router_option != ERR_OK || mask_option != ERR_OK) {
            ESP_LOGW(TAG, "HaLow gateway DHCP option setup failed dns=%d router=%d mask=%d",
                     dns_option, router_option, mask_option);
        }
        gateway_upstream_ip = netif_ip4_addr(ap)->addr;
        netif_set_default(ap);
        s->ready = mesh_server_started && extender_dns_update(&s->mesh, ap, dns, true);
        __atomic_store_n(&ready_ip, s->ready ? local.addr : 0, __ATOMIC_RELEASE);
        set_gateway_advertisement(
            s->ready,
            s->ready ? "Wi-Fi link, DHCP, DNS and NAPT ready" :
                       "gateway forwarding setup incomplete");
        return;
    }
    /* A down SoftAP is not an Internet consumer. Never advertise as a gateway. */
    edgez_mesh_gateway_record_t next = u->gateway;
    if (!netif_is_up(ap)) next.valid = false;
    bool changed = next.valid != s->gateway.valid ||
                   (next.valid && (memcmp(next.mac, s->gateway.mac, 6) ||
                                   memcmp(next.ip, s->gateway.ip, 4)));
    if (changed) {
        s->gateway = next;
        s->generation++;
        __atomic_store_n(&generation, s->generation, __ATOMIC_RELEASE);
        etharp_cleanup_netif(&s->mesh);
        /* Do not keep forwarding DNS to a gateway that has disappeared or
         * changed while route and DHCP state reconverge. */
        (void)extender_dns_update(ap, &s->mesh, NULL, false);
        /* Drop old NAT mappings across gateway changes. Remote NAT state is
         * not shared, so keeping local sessions would conceal broken flows. */
        if (s->nat) { ip_napt_enable_no(ap->num, 0); s->nat = false; }
        s->last_arp_ms = now_ms() - 30000;
        ESP_LOGI(TAG, "gateway %s %02x:%02x:%02x:%02x:%02x:%02x ip=%u.%u.%u.%u",
                 next.valid ? "selected" : "unavailable", next.mac[0], next.mac[1], next.mac[2],
                 next.mac[3], next.mac[4], next.mac[5], next.ip[0], next.ip[1], next.ip[2], next.ip[3]);
    }
    /* The transit interface waits for an advertised IPv4 gateway. */
    netif_set_default(&s->mesh);
    if (!next.valid) {
        netif_set_link_up(&s->mesh);
        return;
    }
    netif_set_link_up(&s->mesh);
    if (!s->dhcp_started) {
        if (dhcp_start(&s->mesh) != ERR_OK) return;
        s->dhcp_started = true;
    }
    if (!dhcp_supplied_address(&s->mesh)) return;
    ip4_addr_t gateway_ip;
    memcpy(&gateway_ip.addr, next.ip, 4);
    if (!ip4_addr_net_eq(&gateway_ip, netif_ip4_addr(&s->mesh), netif_ip4_netmask(&s->mesh))) {
        if (changed) dhcp_network_changed_link_up(&s->mesh);
        return; // A gateway outside our lease subnet cannot be used safely.
    }
    netif_set_gw(&s->mesh, &gateway_ip);
    if (s->last_ip != netif_ip4_addr(&s->mesh)->addr) {
        s->generation++;
        __atomic_store_n(&generation, s->generation, __ATOMIC_RELEASE);
        s->last_ip = netif_ip4_addr(&s->mesh)->addr;
        s->last_arp_ms = now_ms() - 30000;
        if (s->nat) { ip_napt_enable_no(ap->num, 0); s->nat = false; }
        ESP_LOGI(TAG, "mesh DHCP address " IPSTR, IP2STR(netif_ip4_addr(&s->mesh)));
    }
    /* Routed SoftAP clients preserve their source address. The OpenWrt
     * gateway installs the advertised return route and performs WAN NAT. */
    if (ip4_addr_net_eq(netif_ip4_addr(ap), netif_ip4_addr(&s->mesh), netif_ip4_netmask(&s->mesh))) return;
    if (s->nat) { ip_napt_enable_no(ap->num, 0); s->nat = false; }
    s->ready = true;
    ip_addr_t resolver;
    ip_addr_copy_from_ip4(resolver, gateway_ip);
    bool dns_ready = extender_dns_update(ap, &s->mesh, &resolver, true);
    uint8_t local_dns[4];
    memcpy(local_dns, &netif_ip4_addr(ap)->addr, sizeof(local_dns));
    if (!dns_ready) {
        ESP_LOGW(TAG, "SoftAP local DNS relay unavailable");
    } else if (configure_softap_dns(local_dns)) {
        /* DHCP cannot replace DNS in a lease already held by an associated
         * station. Disconnect once after gateway selection; normal WPA2
         * auto-reconnect obtains a fresh lease pointing at the local relay. */
        esp_err_t renew = esp_wifi_deauth_sta(0);
        if (renew != ESP_OK) {
            ESP_LOGW(TAG, "SoftAP client DNS renewal request failed: %s",
                     esp_err_to_name(renew));
        }
    }
    if ((uint32_t)(now_ms() - s->last_arp_ms) >= 30000) {
        (void)etharp_gratuitous(&s->mesh);
        (void)etharp_request(&s->mesh, &gateway_ip);
        s->last_arp_ms = now_ms();
    }
}

static void apply_gateway(void *ctx)
{
    update_t *u = ctx;
    apply_gateway_state(ctx);
    if (!gateway_mode && s->added) {
        struct netif *ap = esp_netif_get_netif_impl(s->ap);
        if (ap) edgez_mesh_alfred_subnet_tick(s->ready ? netif_ip4_addr(&s->mesh)->addr : 0,
                                            netif_ip4_addr(ap)->addr, netif_ip4_netmask(ap)->addr);
    }
    if (!gateway_mode) __atomic_store_n(&ready_ip, s->ready ? netif_ip4_addr(&s->mesh)->addr : 0, __ATOMIC_RELEASE);
    if (s->added) {
        edgez_mesh_iperf_update(&s->mesh, gateway_mode ? esp_netif_get_netif_impl(s->ap) : NULL,
                               s->ready, s->generation);
    }

    uint32_t now = now_ms();
    if ((uint32_t)(now - s->last_status_ms) < 15000) return;
    s->last_status_ms = now;
    const char *stage = gateway_mode ? (s->ready ? "Wi-Fi gateway ready" : "waiting for Wi-Fi upstream/DNS/NAT") :
        !u->gateway_count ? "waiting for BATMAN gateway advertisement" :
        !u->gateway.valid ? "waiting for matching Alfred gateway IPv4 record" :
        !s->gateway.valid ? "SoftAP down or not relay mode" :
        !s->added || !dhcp_supplied_address(&s->mesh) ? "waiting for mesh DHCP lease" :
        !s->ready ? "waiting for usable gateway subnet/NAT" : "ready";
    ESP_LOGI(TAG, "forwarding: %s; routes=%u gateways=%u mesh=" IPSTR " nat=%u",
             stage, (unsigned)u->route_count, (unsigned)u->gateway_count,
             IP2STR(netif_ip4_addr(&s->mesh)), (unsigned)s->nat);
    ESP_LOGI(TAG,
             "DATA_DIAG tx queued=%lu sent=%lu failed=%lu dropped=%lu; "
             "rx seen=%lu queued=%lu lwip=%lu drop_state=%lu drop_mac=%lu "
             "drop_ip=%lu drop_mem=%lu input_err=%lu; "
             "ap_tx ipv4=%lu arp=%lu other=%lu err=%lu; "
             "internal_free=%lu internal_largest=%lu",
             (unsigned long)__atomic_load_n(&s->tx_queued, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->tx_sent, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->tx_failed, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->tx_dropped, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_seen, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_queued, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_delivered, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_drop_state, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_drop_mac, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_drop_ip, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_drop_memory, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->rx_input_error, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->ap_tx_ipv4, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->ap_tx_arp, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->ap_tx_other, __ATOMIC_RELAXED),
             (unsigned long)__atomic_load_n(&s->ap_tx_error, __ATOMIC_RELAXED),
             (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));

    /* Interval counters make one iperf run sufficient to locate the slow
     * boundary: SoftAP/lwIP, extender queues, or Morse radio admission. */
    static uint32_t perf_previous_ms;
    static uint32_t perf_tx_bytes, perf_rx_bytes;
    static uint32_t perf_tx_sent, perf_tx_failed, perf_tx_dropped;
    static uint32_t perf_rx_delivered, perf_rx_dropped;
    static uint32_t perf_tx_submit_us, perf_rx_inject_us, perf_rx_inject_calls;
    const uint32_t elapsed_ms = perf_previous_ms ? now - perf_previous_ms : 0;
    const uint32_t tx_bytes = __atomic_load_n(&s->tx_bytes_sent, __ATOMIC_RELAXED);
    const uint32_t rx_bytes = __atomic_load_n(&s->rx_bytes_delivered, __ATOMIC_RELAXED);
    const uint32_t tx_sent = __atomic_load_n(&s->tx_sent, __ATOMIC_RELAXED);
    const uint32_t tx_failed = __atomic_load_n(&s->tx_failed, __ATOMIC_RELAXED);
    const uint32_t tx_dropped = __atomic_load_n(&s->tx_dropped, __ATOMIC_RELAXED);
    const uint32_t rx_delivered = __atomic_load_n(&s->rx_delivered, __ATOMIC_RELAXED);
    const uint32_t rx_dropped =
        __atomic_load_n(&s->rx_drop_state, __ATOMIC_RELAXED) +
        __atomic_load_n(&s->rx_drop_mac, __ATOMIC_RELAXED) +
        __atomic_load_n(&s->rx_drop_ip, __ATOMIC_RELAXED) +
        __atomic_load_n(&s->rx_drop_memory, __ATOMIC_RELAXED) +
        __atomic_load_n(&s->rx_input_error, __ATOMIC_RELAXED);
    const uint32_t tx_submit_us = __atomic_load_n(&s->tx_submit_us, __ATOMIC_RELAXED);
    const uint32_t rx_inject_us = __atomic_load_n(&s->rx_inject_us, __ATOMIC_RELAXED);
    const uint32_t rx_inject_calls = __atomic_load_n(&s->rx_inject_calls, __ATOMIC_RELAXED);
    if (elapsed_ms != 0) {
        const uint32_t tx_packets = tx_sent - perf_tx_sent;
        const uint32_t rx_packets = rx_delivered - perf_rx_delivered;
        const uint32_t tx_attempts = tx_packets + (tx_failed - perf_tx_failed);
        const uint32_t rx_attempts = rx_inject_calls - perf_rx_inject_calls;
        const uint32_t tx_kbps = (uint32_t)(((uint64_t)(tx_bytes - perf_tx_bytes) * 8U) /
                                             elapsed_ms);
        const uint32_t rx_kbps = (uint32_t)(((uint64_t)(rx_bytes - perf_rx_bytes) * 8U) /
                                             elapsed_ms);
        ESP_LOGW(TAG,
                 "PERF 15s mesh_tx=%lukbps packets=%lu submit_avg=%luus max=%luus fail=%lu drop=%lu q=%lu/%u:%u; "
                 "mesh_rx=%lukbps packets=%lu lwip_avg=%luus max=%luus drop=%lu q=%lu/%u:%u; "
                 "mmpkt_tx=%lu/%lu free; heap=%lu/%lu",
                 (unsigned long)tx_kbps, (unsigned long)tx_packets,
                 (unsigned long)(tx_attempts ? (tx_submit_us - perf_tx_submit_us) / tx_attempts : 0),
                 (unsigned long)__atomic_exchange_n(&s->tx_submit_max_us, 0, __ATOMIC_RELAXED),
                 (unsigned long)(tx_failed - perf_tx_failed),
                 (unsigned long)(tx_dropped - perf_tx_dropped),
                 (unsigned long)__atomic_exchange_n(&s->tx_queue_high_water, 0, __ATOMIC_RELAXED),
                 TX_QUEUE_DEPTH, (unsigned)uxQueueMessagesWaiting(tx_queue),
                 (unsigned long)rx_kbps, (unsigned long)rx_packets,
                 (unsigned long)(rx_attempts ? (rx_inject_us - perf_rx_inject_us) / rx_attempts : 0),
                 (unsigned long)__atomic_exchange_n(&s->rx_inject_max_us, 0, __ATOMIC_RELAXED),
                 (unsigned long)(rx_dropped - perf_rx_dropped),
                 (unsigned long)__atomic_exchange_n(&s->rx_queue_high_water, 0, __ATOMIC_RELAXED),
                 RX_QUEUE_DEPTH, (unsigned)uxQueueMessagesWaiting(rx_queue),
                 (unsigned long)edgez_rf_tx_packet_free_count(),
                 (unsigned long)edgez_rf_tx_packet_total_count(),
                 (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        static const char *const classes[] = {"tcp_ack", "priority", "bulk"};
        for (unsigned i = 0; i < 3; ++i) {
            portENTER_CRITICAL(&tx_diag_lock);
            tx_diag_t d = s->tx_diag[i];
            memset(&s->tx_diag[i], 0, sizeof(s->tx_diag[i]));
            s->tx_diag[i].last_error = d.last_error;
            portEXIT_CRITICAL(&tx_diag_lock);
            ESP_LOGW(TAG,
                     "PERF TX_CLASS class=%s n=%lu queue_avg=%lums max=%lums submit_avg=%luus max=%luus fail=%lu last_err=%d",
                     classes[i], (unsigned long)d.count,
                     (unsigned long)(d.count ? d.queue_ms / d.count : 0),
                     (unsigned long)d.queue_max_ms,
                     (unsigned long)(d.count ? d.submit_us / d.count : 0),
                     (unsigned long)d.submit_max_us, (unsigned long)d.failed,
                     d.last_error);
        }
    }
    perf_previous_ms = now;
    perf_tx_bytes = tx_bytes;
    perf_rx_bytes = rx_bytes;
    perf_tx_sent = tx_sent;
    perf_tx_failed = tx_failed;
    perf_tx_dropped = tx_dropped;
    perf_rx_delivered = rx_delivered;
    perf_rx_dropped = rx_dropped;
    perf_tx_submit_us = tx_submit_us;
    perf_rx_inject_us = rx_inject_us;
    perf_rx_inject_calls = rx_inject_calls;

}

static void receive_frame(void *ctx)
{
    packet_t *item = ctx;
    if (!s->added || (!gateway_mode && !s->gateway.valid)) {
        __atomic_add_fetch(&s->rx_drop_state, 1, __ATOMIC_RELAXED);
        return;
    }
    uint8_t *f = item->data;
    if (!(f[0] & 1) && memcmp(f, s->self, 6)) {
        __atomic_add_fetch(&s->rx_drop_mac, 1, __ATOMIC_RELAXED);
        return;
    }
    if (be16(f + 12) == 0x0800) {
        clamp_tcp_mss(f, item->len);
        if (item->len < 34 || (f[14] >> 4) != 4) {
            __atomic_add_fetch(&s->rx_bad_header, 1, __ATOMIC_RELAXED);
            __atomic_add_fetch(&s->rx_drop_ip, 1, __ATOMIC_RELAXED);
            return;
        }
        size_t ihl = (f[14] & 15) * 4;
        if (ihl < 20 || 14 + ihl > item->len) {
            __atomic_add_fetch(&s->rx_bad_header, 1, __ATOMIC_RELAXED);
            __atomic_add_fetch(&s->rx_drop_ip, 1, __ATOMIC_RELAXED);
            return;
        }
        if (!gateway_mode && f[23] == 17 && !(be16(f + 20) & 0x1fffU) && item->len >= 14 + ihl + 8 && be16(f + 14 + ihl + 2) == 68) {
            // Only accept DHCP service from the selected gateway, even though
            // discovery is broadcast to establish Linux's reverse MAC mapping.
            if (memcmp(f + 26, s->gateway.ip, 4)) {
                __atomic_add_fetch(&s->rx_wrong_dhcp, 1, __ATOMIC_RELAXED);
                __atomic_add_fetch(&s->rx_drop_ip, 1, __ATOMIC_RELAXED);
                return;
            }
        } else if (!gateway_mode && memcmp(f + 30, &netif_ip4_addr(&s->mesh)->addr, 4)) {
            struct netif *ap = esp_netif_get_netif_impl(s->ap);
            ip4_addr_t destination;
            memcpy(&destination.addr, f + 30, 4);
            if (!ap || !ip4_addr_net_eq(&destination, netif_ip4_addr(ap), netif_ip4_netmask(ap))) {
                __atomic_add_fetch(&s->rx_wrong_destination, 1, __ATOMIC_RELAXED);
                __atomic_add_fetch(&s->rx_drop_ip, 1, __ATOMIC_RELAXED);
                return;
            }
        }
        if (!tx_is_priority_frame(f, item->len, item->len)) {
            __atomic_store_n(&s->last_rx_bulk_ms, now_ms(), __ATOMIC_RELAXED);
        }
    }
    struct pbuf *p = pbuf_alloc(PBUF_RAW, item->len, PBUF_RAM);
    if (!p) {
        __atomic_add_fetch(&s->rx_pbuf_alloc, 1, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s->rx_drop_memory, 1, __ATOMIC_RELAXED);
        return;
    }
    if (pbuf_take(p, f, item->len) != ERR_OK) {
        __atomic_add_fetch(&s->rx_pbuf_copy, 1, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s->rx_drop_memory, 1, __ATOMIC_RELAXED);
        pbuf_free(p);
        return;
    }
    err_t input_err = ethernet_input(p, &s->mesh);
    if (input_err != ERR_OK) {
        __atomic_store_n(&s->rx_last_input_error, input_err, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s->rx_input_error, 1, __ATOMIC_RELAXED);
        pbuf_free(p);
        return;
    }
    __atomic_add_fetch(&s->rx_delivered, 1, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s->rx_bytes_delivered, item->len, __ATOMIC_RELAXED);
}

static void rx_worker(void *ctx)
{
    (void)ctx;
    for (;;) {
        packet_t *item;
        if (xQueueReceive(rx_queue, &item, portMAX_DELAY) != pdTRUE) continue;
        int64_t started_us = esp_timer_get_time();
        err_t callback_err = tcpip_callback_wait(receive_frame, item);
        if (callback_err != ERR_OK) {
            __atomic_add_fetch(&s->rx_callback_error, 1, __ATOMIC_RELAXED);
            __atomic_store_n(&s->rx_last_callback_error, callback_err, __ATOMIC_RELAXED);
        }
        uint32_t elapsed_us = (uint32_t)(esp_timer_get_time() - started_us);
        __atomic_add_fetch(&s->rx_inject_us, elapsed_us, __ATOMIC_RELAXED);
        __atomic_add_fetch(&s->rx_inject_calls, 1, __ATOMIC_RELAXED);
        atomic_max_u32(&s->rx_inject_max_us, elapsed_us);
        free(item);
    }
}

/* A single radio admission already waits up to 50 ms. Do not stack retries
 * here: they block the only worker and delay subsequent ACK/control packets. */
static esp_err_t submit_tx_packet(packet_t *item, bool priority)
{
    if (item->generation != __atomic_load_n(&generation, __ATOMIC_ACQUIRE) ||
        !__atomic_load_n(&accepting_packets, __ATOMIC_ACQUIRE)) {
        return ESP_ERR_INVALID_STATE;
    }
    const uint8_t tid = priority ? TX_PRIORITY_TID : 0;
    const uint32_t timeout_ms = priority ? TX_PRIORITY_READY_TIMEOUT_MS :
                                           TX_BULK_READY_TIMEOUT_MS;
    return item->broadcast
        ? edgez_mesh_send_broadcast_qos(item->data, item->len, tid, timeout_ms)
        : edgez_mesh_send_unicast_qos(item->gateway, item->data, item->len, tid, timeout_ms);
}

static void tx_worker(void *ctx)
{
    update_t *u = ctx;
    uint32_t last = now_ms() - 1000;
    unsigned priority_run = 0;
    for (;;) {
        if ((uint32_t)(now_ms() - last) >= 1000 && wifi_extender_get_mac(u->mac)) {
            size_t count = edgez_mesh_snapshot_routes(u->snapshots, EDGEZ_MESH_GATEWAY_LIMIT);
            u->route_count = count;
            u->gateway_count = 0;
            for (size_t i = 0; i < count; ++i) {
                if (u->snapshots[i].gateway) ++u->gateway_count;
                memcpy(u->routes[i].mac, u->snapshots[i].originator, 6);
                u->routes[i].gateway = u->snapshots[i].gateway;
                u->routes[i].tq = u->snapshots[i].tq;
                u->routes[i].down = u->snapshots[i].gateway_down;
                u->routes[i].up = u->snapshots[i].gateway_up;
            }
            (void)edgez_mesh_alfred_select_gateway(u->routes, count, now_ms(), &u->gateway);
            (void)tcpip_callback_wait(apply_gateway, u);
            edgez_mesh_alfred_gateway_tick();
            last = now_ms();
        }
        packet_t *item;
        bool received = false;
        bool priority_item = false;
        if (priority_run < TX_PRIORITY_BURST &&
            tx_priority_receive(&item) == pdTRUE) {
            ++priority_run;
            received = true;
            priority_item = true;
        } else if (xQueueReceive(tx_queue, &item, 0) == pdTRUE) {
            priority_run = 0;
            received = true;
        } else if (tx_priority_receive(&item) == pdTRUE) {
            ++priority_run;
            received = true;
            priority_item = true;
        }
        if (!received) {
            priority_run = 0;
            (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
            continue;
        }
        bool submitted = false;
        if (item->generation == __atomic_load_n(&generation, __ATOMIC_ACQUIRE)) {
            tcp_flow_t flow;
            unsigned tx_class = tx_parse_pure_tcp_ack(item->data, item->len, item->len, &flow)
                                    ? 0 : (priority_item ? 1 : 2);
            tx_diag_t *diag = &s->tx_diag[tx_class];
            uint32_t queue_ms = (uint32_t)(now_ms() - item->tx_enqueued_ms);
            /* Once a best-effort packet has spent this long waiting, sending it
             * only preserves bufferbloat. Drop it before radio admission so TCP
             * applies congestion control and latency-sensitive traffic can use
             * the newly available capacity. Priority traffic is never aged out. */
            if (!priority_item && queue_ms > TX_BULK_MAX_QUEUE_MS) {
                __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
                __atomic_add_fetch(&s->tx_stale_bulk_dropped, 1, __ATOMIC_RELAXED);
                free(item);
                continue;
            }
            int64_t started_us = esp_timer_get_time();
            esp_err_t err = submit_tx_packet(item, priority_item);
            uint32_t elapsed_us = (uint32_t)(esp_timer_get_time() - started_us);
            portENTER_CRITICAL(&tx_diag_lock);
            ++diag->count;
            diag->queue_ms += queue_ms;
            if (queue_ms > diag->queue_max_ms) diag->queue_max_ms = queue_ms;
            diag->submit_us += elapsed_us;
            if (elapsed_us > diag->submit_max_us) diag->submit_max_us = elapsed_us;
            if (err != ESP_OK) {
                ++diag->failed;
                diag->last_error = err;
            }
            portEXIT_CRITICAL(&tx_diag_lock);
            __atomic_add_fetch(&s->tx_submit_us, elapsed_us, __ATOMIC_RELAXED);
            atomic_max_u32(&s->tx_submit_max_us, elapsed_us);
            __atomic_add_fetch(err == ESP_OK ? &s->tx_sent : &s->tx_failed, 1,
                               __ATOMIC_RELAXED);
            if (err == ESP_OK) {
                submitted = true;
                __atomic_add_fetch(&s->tx_bytes_sent, item->len, __ATOMIC_RELAXED);
            }
        } else {
            __atomic_add_fetch(&s->tx_dropped, 1, __ATOMIC_RELAXED);
        }
        free(item);

        /* A bulk upload can otherwise fill Morse's data pool and hide later
         * TCP ACK/control packets behind 30+ full-size frames. While inbound
         * bulk traffic is active, leave a short interruptible admission gap
         * after each bulk TX. A newly queued priority packet wakes us at once;
         * pure uploads are unaffected because inbound ACK-only frames do not
         * refresh last_rx_bulk_ms. */
        uint32_t rx_bulk_ms = __atomic_load_n(&s->last_rx_bulk_ms, __ATOMIC_RELAXED);
        if (submitted && !priority_item && rx_bulk_ms != 0 &&
            (uint32_t)(now_ms() - rx_bulk_ms) < RX_BULK_ACTIVE_MS) {
            __atomic_add_fetch(&s->tx_rx_fairness_waits, 1, __ATOMIC_RELAXED);
            (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(TX_RX_FAIRNESS_WAIT_MS));
        }
    }
}

esp_err_t edgez_mesh_internet_start(esp_netif_t *softap)
{
    if (!softap) return ESP_ERR_INVALID_ARG;
    if (tx_queue && tx_priority_queue && rx_queue) return ESP_OK;
    s = hot_calloc(1, sizeof(*s));
    update_t *u = hot_calloc(1, sizeof(*u));
    QueueHandle_t tx_q = xQueueCreate(TX_QUEUE_DEPTH, sizeof(packet_t *));
    QueueHandle_t tx_priority_q = xQueueCreate(TX_PRIORITY_QUEUE_DEPTH, sizeof(packet_t *));
    QueueHandle_t rx_q = xQueueCreate(RX_QUEUE_DEPTH, sizeof(packet_t *));
    if (!s || !u || !tx_q || !tx_priority_q || !rx_q) {
        free(s); s = NULL; free(u);
        if (tx_q) vQueueDelete(tx_q);
        if (tx_priority_q) vQueueDelete(tx_priority_q);
        if (rx_q) vQueueDelete(rx_q);
        return ESP_ERR_NO_MEM;
    }
    s->ap = softap;
    tx_queue = tx_q;
    tx_priority_queue = tx_priority_q;
    rx_queue = rx_q;
    memset(tx_queued_acks, 0, sizeof(tx_queued_acks));
    /* Match the proven v2 extender: packet copies, state and worker stacks
     * stay in PSRAM, preserving internal SRAM for Morse/Wi-Fi control paths. */
    if (create_worker(rx_worker, "edgez_mesh_inet_rx", RX_WORKER_STACK_SIZE,
                      NULL, 6, &rx_worker_task) != pdPASS) {
        tx_queue = NULL; tx_priority_queue = NULL; rx_queue = NULL;
        vQueueDelete(tx_q); vQueueDelete(tx_priority_q); vQueueDelete(rx_q);
        free(s); s = NULL; free(u);
        return ESP_ERR_NO_MEM;
    }
    if (create_worker(tx_worker, "edgez_mesh_inet_tx", TX_WORKER_STACK_SIZE,
                      u, 4, &tx_worker_task) != pdPASS) {
        vTaskDeleteWithCaps(rx_worker_task);
        rx_worker_task = NULL;
        tx_queue = NULL; tx_priority_queue = NULL; rx_queue = NULL;
        vQueueDelete(tx_q); vQueueDelete(tx_priority_q); vQueueDelete(rx_q);
        free(s); s = NULL; free(u);
        return ESP_ERR_NO_MEM;
    }
    __atomic_store_n(&accepting_packets, true, __ATOMIC_RELEASE);
    ESP_LOGI(TAG,
             "EdgeZ Mesh Network gateway client started, IPv4 MTU=%u txq=%u+%u priority rxq=%u workers=%u/%u %s",
             IP_MTU, TX_QUEUE_DEPTH, TX_PRIORITY_QUEUE_DEPTH, RX_QUEUE_DEPTH,
             TX_WORKER_STACK_SIZE, RX_WORKER_STACK_SIZE, HOT_MEMORY_NAME);
    return ESP_OK;
}

esp_err_t edgez_mesh_internet_start_gateway(esp_netif_t *wifi)
{
    gateway_mode = true;
    ESP_LOGW(TAG,
             "NODE ROLE configured=WIFI_UPSTREAM_GATEWAY active=WAITING_FOR_WIFI batman_gateway_advertise=0");
    return edgez_mesh_internet_start(wifi);
}

void edgez_mesh_internet_wifi_upstream_changed(bool has_ip)
{
    if (!gateway_mode) return;

    if (!has_ip) {
        __atomic_store_n(&ready_ip, 0, __ATOMIC_RELEASE);
        set_gateway_advertisement(false, "Wi-Fi STA disconnected");
    } else {
        ESP_LOGW(TAG,
                 "NODE ROLE configured=WIFI_UPSTREAM_GATEWAY active=VALIDATING_WIFI_IP batman_gateway_advertise=0");
    }

    /* Re-evaluate link/IP, NAPT, DHCP and DNS on the tcpip thread promptly. */
    if (tx_worker_task) xTaskNotifyGive(tx_worker_task);
}


bool edgez_mesh_internet_handle_frame(const uint8_t *frame, size_t len)
{
    if (!rx_queue || !frame || len < 14 ||
        (be16(frame + 12) != 0x0800 && be16(frame + 12) != 0x0806)) return false;
    __atomic_add_fetch(&s->rx_seen, 1, __ATOMIC_RELAXED);
    __atomic_add_fetch(&s->rx_bytes_seen, len, __ATOMIC_RELAXED);
    if (len > ETH_MAX) {
        __atomic_add_fetch(&s->rx_drop_ip, 1, __ATOMIC_RELAXED);
        return true;
    }
    packet_t *item = new_packet(rx_queue, len);
    if (item) {
        item->rx = true; item->len = len; memcpy(item->data, frame, len);
        if (xQueueSend(rx_queue, &item, 0) == pdTRUE) {
            __atomic_add_fetch(&s->rx_queued, 1, __ATOMIC_RELAXED);
            atomic_max_u32(&s->rx_queue_high_water,
                           (uint32_t)uxQueueMessagesWaiting(rx_queue));
        } else {
            __atomic_add_fetch(&s->rx_drop_memory, 1, __ATOMIC_RELAXED);
            free(item);
        }
    } else {
        __atomic_add_fetch(&s->rx_drop_memory, 1, __ATOMIC_RELAXED);
    }
    return true;
}

#else
uint32_t edgez_mesh_internet_ready_ip(void) { return 0; }
esp_err_t edgez_mesh_internet_start_gateway(esp_netif_t *wifi) { (void)wifi; return ESP_ERR_NOT_SUPPORTED; }
void edgez_mesh_internet_wifi_upstream_changed(bool has_ip) { (void)has_ip; }
bool edgez_mesh_internet_gateway_advertised(void) { return false; }
esp_err_t edgez_mesh_internet_start(esp_netif_t *softap) { (void)softap; return ESP_ERR_NOT_SUPPORTED; }
bool edgez_mesh_internet_handle_frame(const uint8_t *frame, size_t len) { (void)frame; (void)len; return false; }
#endif
