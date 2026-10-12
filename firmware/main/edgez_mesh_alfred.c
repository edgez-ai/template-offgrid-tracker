/* Ported from edge-device-esp32-internal wifi-extender (3016950). */
#include "wifi_extender.h"
#include "edgez_mesh_alfred.h"
#include "edgez_mesh_internet.h"
#include "edgez_mesh_ndp.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "wifi_extender_adapter.h"
#include "freertos/FreeRTOS.h"

enum {
    ETHERNET_HEADER_LEN = 14,
    IPV6_HEADER_LEN = 40,
    UDP_HEADER_LEN = 8,
    ALFRED_TLV_LEN = 4,
    ALFRED_PUSH_HEADER_LEN = 8,
    ALFRED_DATA_HEADER_LEN = 10,
    ALFRED_PORT = 0x4242,
    ALFRED_PUSH_DATA = 0,
    ALFRED_ANNOUNCE_PRIMARY = 1,
    ALFRED_STATUS_TXEND = 3,
    ALFRED_VERSION = 0,
    ALFRED_BAT_HOSTS_TYPE = 64,
    EDGEZ_MESH_NODE_TYPE = 102,
    EDGEZ_MESH_NODE_VERSION = 1,
    PUBLISH_INTERVAL_MS = 60000,
    IP_PROTOCOL_UDP = 17,
    ETHERTYPE_IPV6 = 0x86dd,
};

static const char *TAG = "edgez_mesh_alfred";
enum { AD_FRAME, AD_IP_REJECT, AD_LENGTH_REJECT, AD_PORT_REJECT,
       AD_CHECKSUM_REJECT, AD_TLV_REJECT, AD_ANNOUNCE, AD_PUSH,
       AD_UNMATCHED, AD_DECODE_REJECT, AD_COUNT };
static uint32_t s_rx_diag[AD_COUNT];
static void rx_note(unsigned slot) { __atomic_fetch_add(&s_rx_diag[slot], 1U, __ATOMIC_RELAXED); }
static unsigned long rx_count(unsigned slot) { return __atomic_load_n(&s_rx_diag[slot], __ATOMIC_RELAXED); }
static char s_hostname[65] = "EdgeZ-HaLow";
static uint32_t s_last_publish_ms;
static bool s_has_published;
static uint16_t s_transaction_id;
static portMUX_TYPE s_subnet_lock = portMUX_INITIALIZER_UNLOCKED;
static char s_subnet_record[160];
static uint32_t s_subnet_boot, s_subnet_sequence, s_subnet_last;
static uint32_t s_subnet_upstream, s_subnet_router;
static edgez_mesh_gateway_policy_t s_gateways;
static portMUX_TYPE s_gateway_lock = portMUX_INITIALIZER_UNLOCKED;
/* Requests are handled on the HaLow event task. Replies may contain records
 * from many gateways relayed by one Alfred primary. Never infer gateway MAC
 * or IPv4 from the primary's Ethernet/IPv6 source addresses. */
static struct {
    uint8_t ip[16];
    uint8_t peer_mac[6], originator[6];
    uint16_t transaction;
    uint8_t data_type;
    uint32_t requested_ms;
    bool valid;
} s_requests[8];

bool edgez_mesh_alfred_select_gateway(const edgez_mesh_gateway_route_t *routes,
                                     size_t count, uint32_t now,
                                     edgez_mesh_gateway_record_t *selected)
{
    if (!selected) return false;
    /* Called once per second by the Internet worker, including when no Alfred
     * packets arrive. RX updates are atomic; logging is outside all locks. */
    static uint32_t last_report;
    if ((uint32_t)(now - last_report) >= 15000) {
        last_report = now;
        ESP_LOGI(TAG, "RX_DIAG cumulative frames=%lu ip_reject=%lu length_reject=%lu port_reject=%lu checksum_reject=%lu tlv_reject=%lu announce=%lu push=%lu unmatched=%lu decode_reject=%lu",
                 rx_count(AD_FRAME), rx_count(AD_IP_REJECT), rx_count(AD_LENGTH_REJECT),
                 rx_count(AD_PORT_REJECT), rx_count(AD_CHECKSUM_REJECT), rx_count(AD_TLV_REJECT),
                 rx_count(AD_ANNOUNCE), rx_count(AD_PUSH), rx_count(AD_UNMATCHED), rx_count(AD_DECODE_REJECT));
    }
    portENTER_CRITICAL(&s_gateway_lock);
    bool changed = edgez_mesh_gateway_select(&s_gateways, routes, count, now);
    *selected = s_gateways.selected;
    portEXIT_CRITICAL(&s_gateway_lock);
    return changed;
}

static uint16_t read_be16(const uint8_t *p)
{
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static void write_be16(uint8_t *p, uint16_t value)
{
    p[0] = (uint8_t)(value >> 8);
    p[1] = (uint8_t)value;
}

static void write_be32(uint8_t *p, uint32_t value)
{
    p[0] = (uint8_t)(value >> 24);
    p[1] = (uint8_t)(value >> 16);
    p[2] = (uint8_t)(value >> 8);
    p[3] = (uint8_t)value;
}

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

static void mac_to_link_local(const uint8_t mac[6], uint8_t address[16])
{
    memset(address, 0, 16);
    address[0] = 0xfe;
    address[1] = 0x80;
    address[8] = mac[0] ^ 0x02U;
    address[9] = mac[1];
    address[10] = mac[2];
    address[11] = 0xff;
    address[12] = 0xfe;
    address[13] = mac[3];
    address[14] = mac[4];
    address[15] = mac[5];
}

static uint32_t checksum_add(uint32_t sum, const uint8_t *data, size_t len)
{
    while (len >= 2) {
        sum += read_be16(data);
        data += 2;
        len -= 2;
    }
    if (len) {
        sum += (uint16_t)data[0] << 8;
    }
    return sum;
}

static uint16_t checksum_finish(uint32_t sum)
{
    while (sum >> 16) {
        sum = (sum & 0xffffU) + (sum >> 16);
    }
    uint16_t result = (uint16_t)~sum;
    return result ? result : 0xffffU;
}

static uint16_t udp6_checksum(const uint8_t source[16],
                              const uint8_t destination[16],
                              const uint8_t *udp, size_t udp_len)
{
    uint32_t sum = 0;
    uint8_t pseudo_tail[8] = {0};
    write_be32(pseudo_tail, (uint32_t)udp_len);
    pseudo_tail[7] = IP_PROTOCOL_UDP;
    sum = checksum_add(sum, source, 16);
    sum = checksum_add(sum, destination, 16);
    sum = checksum_add(sum, pseudo_tail, sizeof(pseudo_tail));
    sum = checksum_add(sum, udp, udp_len);
    return checksum_finish(sum);
}

static esp_err_t send_udp(const uint8_t route_mac[6],
                          const uint8_t peer_mac[6],
                          const uint8_t peer_ip[16],
                          const uint8_t *payload, size_t payload_len)
{
    uint8_t self_mac[6] = {0};
    if (!wifi_extender_get_mac(self_mac)) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t frame[ETHERNET_HEADER_LEN + IPV6_HEADER_LEN + UDP_HEADER_LEN + 480] = {0};
    if (payload_len > sizeof(frame) - ETHERNET_HEADER_LEN - IPV6_HEADER_LEN - UDP_HEADER_LEN) {
        return ESP_ERR_INVALID_SIZE;
    }

    uint8_t self_ip[16];
    mac_to_link_local(self_mac, self_ip);
    memcpy(frame, peer_mac, 6);
    memcpy(frame + 6, self_mac, 6);
    write_be16(frame + 12, ETHERTYPE_IPV6);

    uint8_t *ipv6 = frame + ETHERNET_HEADER_LEN;
    ipv6[0] = 0x60;
    write_be16(ipv6 + 4, (uint16_t)(UDP_HEADER_LEN + payload_len));
    ipv6[6] = IP_PROTOCOL_UDP;
    ipv6[7] = 1;
    memcpy(ipv6 + 8, self_ip, 16);
    memcpy(ipv6 + 24, peer_ip, 16);

    uint8_t *udp = ipv6 + IPV6_HEADER_LEN;
    write_be16(udp, ALFRED_PORT);
    write_be16(udp + 2, ALFRED_PORT);
    write_be16(udp + 4, (uint16_t)(UDP_HEADER_LEN + payload_len));
    memcpy(udp + UDP_HEADER_LEN, payload, payload_len);
    write_be16(udp + 6, udp6_checksum(self_ip, peer_ip, udp,
                                      UDP_HEADER_LEN + payload_len));

    if (route_mac[0] & 1) return edgez_mesh_send_broadcast(
        frame, ETHERNET_HEADER_LEN + IPV6_HEADER_LEN + UDP_HEADER_LEN + payload_len);
    return edgez_mesh_send_unicast(
        route_mac, frame, ETHERNET_HEADER_LEN + IPV6_HEADER_LEN +
                         UDP_HEADER_LEN + payload_len);
}

void edgez_mesh_alfred_gateway_tick(void)
{
    static uint32_t last;
    uint32_t now = now_ms();
    if (!wifi_extender_is_gateway() || !edgez_mesh_internet_ready_ip() || now - last < 5000) return;
    last = now;
    const uint8_t route[6] = {255,255,255,255,255,255};
    const uint8_t mac[6] = {0x33,0x33,0,0,0,1};
    const uint8_t ip[16] = {0xff,2,0,0,0,0,0,0,0,0,0,0,0,0,0,1};
    const uint8_t announce[4] = {ALFRED_ANNOUNCE_PRIMARY,ALFRED_VERSION,0,0};
    (void)send_udp(route, mac, ip, announce, sizeof(announce));
}

static void gateway_request(const uint8_t *route, const uint8_t *peer,
                            const uint8_t *ip, uint16_t id)
{
    uint32_t address = edgez_mesh_internet_ready_ip();
    uint8_t mac[6];
    if (!wifi_extender_is_gateway() || !address || !wifi_extender_get_mac(mac)) return;
    char macstr[18], ipstr[16];
    const uint8_t *a = (const uint8_t *)&address;
    snprintf(macstr,sizeof(macstr),"%02x:%02x:%02x:%02x:%02x:%02x",mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    snprintf(ipstr,sizeof(ipstr),"%u.%u.%u.%u",a[0],a[1],a[2],a[3]);
    uint8_t packet[64] = {ALFRED_PUSH_DATA,ALFRED_VERSION};
    write_be16(packet+4,id);
    memcpy(packet+8,mac,6); packet[14]=100; packet[15]=1;
    size_t n=18;
    packet[n++]=0x0a;packet[n++]=17;memcpy(packet+n,macstr,17);n+=17;
    packet[n++]=0x1a;packet[n++]=strlen(ipstr);memcpy(packet+n,ipstr,strlen(ipstr));n+=strlen(ipstr);
    write_be16(packet+16,n-18);write_be16(packet+2,n-4);
    /* A request can arrive before the reverse BATMAN/TT route has converged.
     * Keep the inner Ethernet and IPv6 destination addressed to the requester,
     * but carry the tiny discovery reply in a BATMAN broadcast. This is the
     * same startup-safe pattern used by our IPv6 neighbor advertisements and
     * lets an ESP gateway interoperate as reliably as an established Linux
     * EdgeZ Mesh Network gateway. The transaction ID still makes the reply useful only
     * to the node which requested it. */
    const uint8_t broadcast_route[6] = {255,255,255,255,255,255};
    esp_err_t record_err = send_udp(broadcast_route,peer,ip,packet,n);
    uint8_t end[8]={ALFRED_STATUS_TXEND,ALFRED_VERSION,0,4};
    write_be16(end+4,id);write_be16(end+6,1);
    esp_err_t end_err = send_udp(broadcast_route,peer,ip,end,sizeof(end));
    static bool reply_logged;
    if (!reply_logged || record_err != ESP_OK || end_err != ESP_OK) {
        ESP_LOGW(TAG,
                 "gateway record reply transaction=%u route=%02x:%02x:%02x:%02x:%02x:%02x record=%s end=%s",
                 id, route[0], route[1], route[2], route[3], route[4], route[5],
                 esp_err_to_name(record_err), esp_err_to_name(end_err));
        if (record_err == ESP_OK && end_err == ESP_OK) reply_logged = true;
    } else {
        ESP_LOGI(TAG, "gateway record reply transaction=%u record=%s end=%s",
                 id, esp_err_to_name(record_err), esp_err_to_name(end_err));
    }
}

static esp_err_t publish_record(const uint8_t route_mac[6],
                                const uint8_t peer_mac[6],
                                const uint8_t peer_ip[16], uint8_t data_type,
                                uint8_t data_version, const uint8_t *data,
                                size_t data_len)
{
    uint8_t self_mac[6] = {0};
    uint8_t packet[ALFRED_PUSH_HEADER_LEN + ALFRED_DATA_HEADER_LEN + 384] = {0};
    if (!data || data_len > sizeof(packet) - ALFRED_PUSH_HEADER_LEN -
                                      ALFRED_DATA_HEADER_LEN ||
        !wifi_extender_get_mac(self_mac)) {
        return ESP_ERR_INVALID_ARG;
    }

    portENTER_CRITICAL(&s_subnet_lock);
    uint16_t tx_id = ++s_transaction_id;
    if (tx_id == 0) {
        tx_id = ++s_transaction_id;
    }
    portEXIT_CRITICAL(&s_subnet_lock);

    packet[0] = ALFRED_PUSH_DATA;
    packet[1] = ALFRED_VERSION;
    write_be16(packet + 2, (uint16_t)(4 + ALFRED_DATA_HEADER_LEN + data_len));
    write_be16(packet + 4, tx_id);
    write_be16(packet + 6, 0);
    memcpy(packet + 8, self_mac, 6);
    packet[14] = data_type;
    packet[15] = data_version;
    write_be16(packet + 16, (uint16_t)data_len);
    memcpy(packet + 18, data, data_len);

    esp_err_t err = send_udp(route_mac, peer_mac, peer_ip, packet,
                             ALFRED_PUSH_HEADER_LEN + ALFRED_DATA_HEADER_LEN +
                                 data_len);
    if (err != ESP_OK) {
        return err;
    }

    uint8_t tx_end[8] = {ALFRED_STATUS_TXEND, ALFRED_VERSION, 0, 4};
    write_be16(tx_end + 4, tx_id);
    write_be16(tx_end + 6, 1);
    return send_udp(route_mac, peer_mac, peer_ip, tx_end, sizeof(tx_end));
}

void edgez_mesh_alfred_subnet_tick(uint32_t upstream, uint32_t router, uint32_t mask)
{
    if (wifi_extender_is_gateway()) return;
    uint32_t now = now_ms();
    if (s_subnet_boot && upstream == s_subnet_upstream && router == s_subnet_router &&
        (uint32_t)(now - s_subnet_last) < 10000) return;
    if (!s_subnet_boot) s_subnet_boot = esp_random() | 1U;
    s_subnet_last = now;
    s_subnet_upstream = upstream;
    s_subnet_router = router;
    uint32_t network = router & mask;
    const uint8_t *n = (const uint8_t *)&network;
    const uint8_t *hop = (const uint8_t *)&upstream;
    /* A withdrawal retains the last valid next hop; lifetime zero removes it. */
    static uint32_t last_hop;
    if (upstream) last_hop = upstream;
    if (!last_hop) return;
    if (!upstream) hop = (const uint8_t *)&last_hop;
    char record[160] = {0};
    snprintf(record, sizeof(record), "EZ4R1 %08lx %08lx %u.%u.%u.%u/27 %u.%u.%u.%u %u",
             (unsigned long)s_subnet_boot, (unsigned long)++s_subnet_sequence,
             n[0], n[1], n[2], n[3], hop[0], hop[1], hop[2], hop[3], upstream ? 45U : 0U);
    portENTER_CRITICAL(&s_subnet_lock);
    memcpy(s_subnet_record, record, sizeof(record));
    portEXIT_CRITICAL(&s_subnet_lock);
}

static void publish_subnet(const uint8_t route[6], const uint8_t peer[6], const uint8_t ip[16])
{
    char record[160];
    portENTER_CRITICAL(&s_subnet_lock);
    memcpy(record, s_subnet_record, sizeof(record));
    portEXIT_CRITICAL(&s_subnet_lock);
    if (!record[0]) return;
    esp_err_t err = publish_record(route, peer, ip, 104, 2,
                                   (const uint8_t *)record, strlen(record));
    ESP_LOGI(TAG, "Alfred IPv4 subnet record: %s (%s)", record, esp_err_to_name(err));
}

static esp_err_t publish_bat_hosts(const uint8_t route_mac[6],
                                   const uint8_t peer_mac[6],
                                   const uint8_t peer_ip[16],
                                   const uint8_t self_mac[6])
{
    char host_label[sizeof(s_hostname)];
    strlcpy(host_label, s_hostname, sizeof(host_label));
    for (size_t i = 0; host_label[i]; ++i) {
        if (host_label[i] == ' ' || host_label[i] == '\t' ||
            host_label[i] == '\r' || host_label[i] == '\n') {
            host_label[i] = '_';
        }
    }
    char value[128];
    int len = snprintf(value, sizeof(value),
                       "%02x:%02x:%02x:%02x:%02x:%02x %s_halow0\n",
                       self_mac[0], self_mac[1], self_mac[2], self_mac[3],
                       self_mac[4], self_mac[5], host_label);
    if (len <= 0 || (size_t)len >= sizeof(value)) {
        return ESP_ERR_INVALID_SIZE;
    }
    return publish_record(route_mac, peer_mac, peer_ip,
                          ALFRED_BAT_HOSTS_TYPE, 0,
                          (const uint8_t *)value, (size_t)len);
}

static esp_err_t publish_node(const uint8_t route_mac[6],
                              const uint8_t peer_mac[6],
                              const uint8_t peer_ip[16],
                              const uint8_t self_mac[6])
{
    /* Node protobuf fields 1 (MAC) and 2 (hostname), both bounded strings.
     * Each length fits in one varint byte; no generated protobuf dependency. */
    char mac[18];
    snprintf(mac, sizeof(mac), "%02x:%02x:%02x:%02x:%02x:%02x",
             self_mac[0], self_mac[1], self_mac[2],
             self_mac[3], self_mac[4], self_mac[5]);
    uint8_t encoded[2 + 17 + 2 + 64];
    size_t length = 0;
    encoded[length++] = 0x0a;
    encoded[length++] = 17;
    memcpy(encoded + length, mac, 17);
    length += 17;
    const size_t hostname_len = strlen(s_hostname);
    encoded[length++] = 0x12;
    encoded[length++] = (uint8_t)hostname_len;
    memcpy(encoded + length, s_hostname, hostname_len);
    length += hostname_len;
    return publish_record(route_mac, peer_mac, peer_ip, EDGEZ_MESH_NODE_TYPE,
                          EDGEZ_MESH_NODE_VERSION, encoded, length);
}

static void publish_all(const uint8_t route_mac[6],
                        const uint8_t peer_mac[6], const uint8_t peer_ip[16])
{
    uint8_t self_mac[6] = {0};
    if (!wifi_extender_get_mac(self_mac)) {
        return;
    }
    esp_err_t host_err = publish_bat_hosts(route_mac, peer_mac, peer_ip,
                                           self_mac);
    esp_err_t node_err = publish_node(route_mac, peer_mac, peer_ip, self_mac);
    if (host_err == ESP_OK && node_err == ESP_OK) {
        ESP_LOGI(TAG,
                 "Published Alfred hostname='%s' to %02x:%02x:%02x:%02x:%02x:%02x",
                 s_hostname, route_mac[0], route_mac[1],
                 route_mac[2], route_mac[3], route_mac[4], route_mac[5]);
    } else {
        ESP_LOGW(TAG, "Alfred publish failed hosts=%s node=%s",
                 esp_err_to_name(host_err), esp_err_to_name(node_err));
    }
}

void edgez_mesh_alfred_set_hostname(const char *hostname)
{
    if (hostname && hostname[0]) {
        strlcpy(s_hostname, hostname, sizeof(s_hostname));
    }
}

const char *edgez_mesh_alfred_get_hostname(void)
{
    return s_hostname;
}

void edgez_mesh_alfred_handle_frame(const uint8_t originator[6],
                                   const uint8_t *frame, size_t frame_len)
{
    rx_note(AD_FRAME);
    uint8_t self[6], advertisement[EDGEZ_MESH_NDP_REPLY_LEN];
    if (wifi_extender_get_mac(self)) {
        size_t n = edgez_mesh_ndp_reply(self, frame, frame_len, advertisement, sizeof(advertisement));
        if (n) {
            /* BATMAN broadcast supplies our originator for Linux's reverse
             * Ethernet-MAC learning, even when the inner NA is unicast. */
            esp_err_t err = edgez_mesh_send_broadcast(advertisement, n);
            ESP_LOGI(TAG, "IPv6 neighbor advertisement: %s", esp_err_to_name(err));
            return;
        }
    }
    if (!originator || !frame || frame_len < ETHERNET_HEADER_LEN + IPV6_HEADER_LEN +
                                  UDP_HEADER_LEN + ALFRED_TLV_LEN ||
        read_be16(frame + 12) != ETHERTYPE_IPV6) {
        rx_note(AD_IP_REJECT);
        return;
    }
    const uint8_t *ipv6 = frame + ETHERNET_HEADER_LEN;
    if ((ipv6[0] >> 4) != 6 || ipv6[6] != IP_PROTOCOL_UDP ||
        ipv6[8] != 0xfe || (ipv6[9] & 0xc0U) != 0x80U) {
        rx_note(AD_IP_REJECT);
        return;
    }
    size_t ipv6_payload_len = read_be16(ipv6 + 4);
    if (ipv6_payload_len < UDP_HEADER_LEN + ALFRED_TLV_LEN ||
        ipv6_payload_len > frame_len - ETHERNET_HEADER_LEN - IPV6_HEADER_LEN) {
        rx_note(AD_LENGTH_REJECT);
        return;
    }
    const uint8_t *udp = ipv6 + IPV6_HEADER_LEN;
    size_t udp_len = read_be16(udp + 4);
    if (udp_len != ipv6_payload_len || udp_len < UDP_HEADER_LEN + ALFRED_TLV_LEN) {
        rx_note(AD_LENGTH_REJECT);
        return;
    }
    if (read_be16(udp) != ALFRED_PORT || read_be16(udp + 2) != ALFRED_PORT) {
        rx_note(AD_PORT_REJECT);
        return;
    }
    const uint8_t *alfred = udp + UDP_HEADER_LEN;
    if (!read_be16(udp + 6) || udp6_checksum(ipv6 + 8, ipv6 + 24, udp, udp_len) != 0xffff) {
        rx_note(AD_CHECKSUM_REJECT);
        return;
    }
    if (alfred[1] != ALFRED_VERSION || read_be16(alfred + 2) != udp_len - UDP_HEADER_LEN - 4) {
        rx_note(AD_TLV_REJECT);
        return;
    }
    /* Alfred request: type=2, data type then transaction ID. */
    if (alfred[0] == 2 && udp_len == UDP_HEADER_LEN + 7 && alfred[4] == 100) {
        gateway_request(originator, frame + 6, ipv6 + 8, read_be16(alfred + 5));
        return;
    }
    uint32_t now = now_ms();
    if (alfred[0] == ALFRED_PUSH_DATA) {
        rx_note(AD_PUSH);
        size_t len = udp_len - UDP_HEADER_LEN;
        if (len < ALFRED_PUSH_HEADER_LEN) return;
        uint8_t requested_type = 0;
        size_t request_slot = 0;
        for (size_t i = 0; i < 8; ++i) {
            if (s_requests[i].valid && !memcmp(s_requests[i].ip, ipv6 + 8, 16) &&
                s_requests[i].transaction == read_be16(alfred + 4) &&
                (uint32_t)(now - s_requests[i].requested_ms) < 10000) {
                requested_type = s_requests[i].data_type;
                request_slot = i;
            }
        }
        bool accepted = false;
        for (size_t off = ALFRED_PUSH_HEADER_LEN; off + ALFRED_DATA_HEADER_LEN <= len;) {
            const uint8_t *record = alfred + off;
            size_t n = read_be16(record + 8);
            if (n > len - off - ALFRED_DATA_HEADER_LEN) return;
            if (requested_type == 105 && record[6] == 105 && record[7] == 0) {
                uint8_t owner_originator[6];
                edgez_mesh_gateway_record_t gateway;
                /* Alfred owner is often br-ahwlan's MAC, not the radio MAC.
                 * Resolve the record owner, never assume the primary owns it. */
                bool resolved = edgez_mesh_resolve_originator(record, owner_originator);
                /* A node joining after the bridge's TT diff can still map
                 * the primary's OWN record from its broadcast announcement.
                 * Never apply this mapping to records relayed for others. */
                if (!resolved && !memcmp(record, s_requests[request_slot].peer_mac, 6)) {
                    memcpy(owner_originator, s_requests[request_slot].originator, 6);
                    resolved = true;
                }
                if (resolved &&
                    edgez_mesh_gateway_decode_ezgw(record + ALFRED_DATA_HEADER_LEN, n,
                                          owner_originator, &gateway)) {
                    portENTER_CRITICAL(&s_gateway_lock);
                    edgez_mesh_gateway_record(&s_gateways, &gateway, now);
                    portEXIT_CRITICAL(&s_gateway_lock);
                    ESP_LOGI(TAG, "EZGW1 gateway %02x:%02x:%02x:%02x:%02x:%02x IPv4=%u.%u.%u.%u sequence=%lu lifetime=%lu",
                             gateway.mac[0], gateway.mac[1], gateway.mac[2],
                             gateway.mac[3], gateway.mac[4], gateway.mac[5],
                             gateway.ip[0], gateway.ip[1], gateway.ip[2], gateway.ip[3],
                             (unsigned long)gateway.sequence,
                             (unsigned long)gateway.lifetime_ms);
                    accepted = true;
                } else {
                    rx_note(AD_DECODE_REJECT);
                }
            }
            if (requested_type == 100 && record[6] == 100 && record[7] == 1) {
                edgez_mesh_gateway_record_t gateway;
                if (edgez_mesh_gateway_decode(record + ALFRED_DATA_HEADER_LEN, n, &gateway)) {
                    portENTER_CRITICAL(&s_gateway_lock);
                    edgez_mesh_gateway_record(&s_gateways, &gateway, now);
                    portEXIT_CRITICAL(&s_gateway_lock);
                    ESP_LOGI(TAG, "gateway record %02x:%02x:%02x:%02x:%02x:%02x IPv4=%u.%u.%u.%u",
                             gateway.mac[0], gateway.mac[1], gateway.mac[2], gateway.mac[3],
                             gateway.mac[4], gateway.mac[5], gateway.ip[0], gateway.ip[1],
                             gateway.ip[2], gateway.ip[3]);
                    accepted = true;
                } else {
                    rx_note(AD_DECODE_REJECT);
                }
            }
            off += ALFRED_DATA_HEADER_LEN + n;
        }
        if (!accepted) rx_note(AD_UNMATCHED);
        return;
    }
    if (alfred[0] != ALFRED_ANNOUNCE_PRIMARY ||
        alfred[1] != ALFRED_VERSION || read_be16(alfred + 2) != 0) {
        return;
    }

    rx_note(AD_ANNOUNCE);
    if (wifi_extender_get_mac(self)) {
        size_t n = edgez_mesh_ndp_advertisement(self, frame + 6, ipv6 + 8,
                                         advertisement, sizeof(advertisement));
        if (n) edgez_mesh_send_broadcast(advertisement, n);
    }
    /* Respond to each primary announcement, independent of node-info throttle. */
    publish_subnet(originator, frame + 6, ipv6 + 8);
    for (uint8_t data_type = 100; data_type <= 105; data_type += 5) {
        size_t slot = 0;
        for (size_t i = 0; i < 8; ++i) {
            if (s_requests[i].valid && s_requests[i].data_type == data_type &&
                !memcmp(s_requests[i].ip, ipv6 + 8, 16)) {
                slot = i; break;
            }
            if (!s_requests[i].valid || (uint32_t)(now - s_requests[i].requested_ms) >
                                         (uint32_t)(now - s_requests[slot].requested_ms)) slot = i;
        }
        if (!s_requests[slot].valid || s_requests[slot].data_type != data_type ||
            memcmp(s_requests[slot].ip, ipv6 + 8, 16) ||
            (uint32_t)(now - s_requests[slot].requested_ms) >= 5000) {
            uint8_t request[7] = {2, ALFRED_VERSION, 0, 3, 100, 0, 0};
            request[4] = data_type;
            uint16_t id = (uint16_t)esp_random();
            write_be16(request + 5, id);
            esp_err_t request_err = send_udp(originator, frame + 6, ipv6 + 8, request, sizeof(request));
            ESP_LOGI(TAG, "gateway record request type=%u transaction=%u: %s",
                     data_type, id, esp_err_to_name(request_err));
            if (request_err == ESP_OK) {
                memcpy(s_requests[slot].ip, ipv6 + 8, 16);
                memcpy(s_requests[slot].peer_mac, frame + 6, 6);
                memcpy(s_requests[slot].originator, originator, 6);
                s_requests[slot].transaction = id;
                s_requests[slot].data_type = data_type;
                s_requests[slot].requested_ms = now;
                s_requests[slot].valid = true;
            }
        }
    }
    if (s_has_published &&
        (uint32_t)(now - s_last_publish_ms) < PUBLISH_INTERVAL_MS) {
        return;
    }
    s_last_publish_ms = now;
    s_has_published = true;
    /* The encapsulated Ethernet source is br-ahwlan, while BATMAN routes to
     * the broadcaster's bat0 originator. Keep both identities distinct. */
    publish_all(originator, frame + 6, ipv6 + 8);
}
