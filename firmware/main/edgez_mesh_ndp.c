/* Ported from edge-device-esp32-internal wifi-extender (3016950). */
#include "edgez_mesh_ndp.h"
#include <stdbool.h>
#include <string.h>

static unsigned be16(const uint8_t *p) { return ((unsigned)p[0] << 8) | p[1]; }
static uint32_t sum_bytes(uint32_t sum, const uint8_t *p, size_t n)
{
    while (n >= 2) { sum += be16(p); p += 2; n -= 2; }
    if (n) sum += (unsigned)*p << 8;
    return sum;
}
static uint16_t checksum(const uint8_t *ip, size_t n)
{
    uint32_t sum = sum_bytes((uint32_t)n + 58, ip + 8, 32);
    sum = sum_bytes(sum, ip + 40, n);
    while (sum >> 16) sum = (sum & 65535) + (sum >> 16);
    return (uint16_t)~sum;
}

static void link_local(const uint8_t mac[6], uint8_t ip[16])
{
    memset(ip, 0, 16);
    ip[0] = 0xfe; ip[1] = 0x80;
    ip[8] = mac[0] ^ 2; ip[9] = mac[1]; ip[10] = mac[2];
    ip[11] = 0xff; ip[12] = 0xfe;
    memcpy(ip + 13, mac + 3, 3);
}

size_t edgez_mesh_ndp_advertisement(const uint8_t mac[6], const uint8_t peer_mac[6],
                            const uint8_t peer_ip[16], uint8_t *reply,
                            size_t capacity)
{
    if (!mac || !peer_mac || !peer_ip || !reply || capacity < EDGEZ_MESH_NDP_REPLY_LEN ||
        peer_ip[0] != 0xfe || (peer_ip[1] & 0xc0U) != 0x80U) return 0;
    memset(reply, 0, EDGEZ_MESH_NDP_REPLY_LEN);
    const uint8_t all_nodes_mac[6] = {0x33, 0x33, 0, 0, 0, 1};
    const uint8_t all_nodes_ip[16] = {
        0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
    };
    (void)peer_mac;
    memcpy(reply, all_nodes_mac, 6);
    memcpy(reply + 6, mac, 6);
    reply[12] = 0x86; reply[13] = 0xdd;
    uint8_t self[16];
    link_local(mac, self);
    uint8_t *ip = reply + 14, *na = ip + 40;
    ip[0] = 0x60; ip[5] = 32; ip[6] = 58; ip[7] = 255;
    memcpy(ip + 8, self, 16);
    memcpy(ip + 24, all_nodes_ip, 16);
    na[0] = 136;
    na[4] = 0x20; /* Override, but not Solicited: this is proactive. */
    memcpy(na + 8, self, 16);
    na[24] = 2; na[25] = 1;
    memcpy(na + 26, mac, 6);
    uint16_t c = checksum(ip, 32);
    na[2] = c >> 8; na[3] = (uint8_t)c;
    return EDGEZ_MESH_NDP_REPLY_LEN;
}

size_t edgez_mesh_ndp_reply(const uint8_t mac[6], const uint8_t *frame, size_t len,
                    uint8_t *reply, size_t capacity)
{
    if (!mac || !frame || !reply || capacity < EDGEZ_MESH_NDP_REPLY_LEN || len < 78 ||
        be16(frame + 12) != 0x86dd || (frame[6] & 1)) return 0;
    const uint8_t *ip = frame + 14, *ns = ip + 40;
    size_t n = be16(ip + 4);
    if ((ip[0] >> 4) != 6 || ip[6] != 58 || ip[7] != 255 ||
        n < 24 || n > len - 54 || ns[0] != 135 || ns[1] ||
        ip[8] == 0xff || checksum(ip, n)) return 0;
    uint8_t self[16] = {0xfe, 0x80};
    self[8] = mac[0] ^ 2; self[9] = mac[1]; self[10] = mac[2];
    self[11] = 0xff; self[12] = 0xfe;
    memcpy(self + 13, mac + 3, 3);
    uint8_t solicited[16] = {0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xff};
    memcpy(solicited + 13, self + 13, 3);
    const uint8_t zero[16] = {0};
    bool dad = !memcmp(ip + 8, zero, 16);
    if (memcmp(ns + 8, self, 16) ||
        (memcmp(ip + 24, solicited, 16) && (dad || memcmp(ip + 24, self, 16)))) return 0;
    for (size_t off = 24; off < n;) {
        if (n - off < 2 || !ns[off + 1]) return 0;
        size_t size = (size_t)ns[off + 1] * 8;
        if (size > n - off || (ns[off] == 1 && (dad || size != 8))) return 0;
        off += size;
    }
    memset(reply, 0, EDGEZ_MESH_NDP_REPLY_LEN);
    memcpy(reply, frame + 6, 6);
    memcpy(reply + 6, mac, 6);
    reply[12] = 0x86; reply[13] = 0xdd;
    uint8_t *out = reply + 14, *na = out + 40;
    out[0] = 0x60; out[5] = 32; out[6] = 58; out[7] = 255;
    memcpy(out + 8, self, 16);
    memcpy(out + 24, ip + 8, 16);
    if (dad) {
        const uint8_t all_nodes[16] = {0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
        const uint8_t all_nodes_mac[6] = {0x33, 0x33, 0, 0, 0, 1};
        memcpy(out + 24, all_nodes, 16); memcpy(reply, all_nodes_mac, 6);
    }
    na[0] = 136; na[4] = dad ? 0x20 : 0x60;
    memcpy(na + 8, self, 16);
    na[24] = 2; na[25] = 1; memcpy(na + 26, mac, 6);
    uint16_t c = checksum(out, 32);
    na[2] = c >> 8; na[3] = (uint8_t)c;
    return EDGEZ_MESH_NDP_REPLY_LEN;
}
