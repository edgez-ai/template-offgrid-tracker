/* Ported from edge-device-esp32-internal wifi-extender (3016950). */
#include "edgez_mesh_gateway_policy.h"
#include <string.h>

static bool varint(const uint8_t **p, const uint8_t *end, uint64_t *v)
{
    *v = 0;
    for (unsigned i = 0; i < 10 && *p < end; ++i) {
        uint8_t b = *(*p)++;
        if (i == 9 && b > 1) return false;
        *v |= (uint64_t)(b & 127) << (7 * i);
        if (!(b & 128)) return true;
    }
    return false;
}

static int hex(uint8_t c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_mac(const uint8_t *p, size_t n, uint8_t mac[6])
{
    if (n != 17) return false;
    unsigned any = 0;
    for (unsigned i = 0; i < 6; ++i) {
        int a = hex(p[3*i]), b = hex(p[3*i+1]);
        if (a < 0 || b < 0 || (i < 5 && p[3*i+2] != ':')) return false;
        mac[i] = (a << 4) | b; any |= mac[i];
    }
    return any && !(mac[0] & 1);
}

static bool parse_ip(const uint8_t *p, size_t n, uint8_t ip[4])
{
    size_t pos = 0;
    for (unsigned i = 0; i < 4; ++i) {
        unsigned value = 0, digits = 0;
        while (pos < n && p[pos] >= '0' && p[pos] <= '9') {
            value = value * 10 + p[pos++] - '0';
            if (++digits > 3 || value > 255) return false;
        }
        if (!digits) return false;
        ip[i] = value;
        if (i < 3 && (pos >= n || p[pos++] != '.')) return false;
    }
    return pos == n && ip[0] != 0 && ip[0] != 127 && ip[0] < 224 &&
           !(ip[0] == 169 && ip[1] == 254);
}

bool edgez_mesh_gateway_decode(const uint8_t *data, size_t len, edgez_mesh_gateway_record_t *out)
{
    if (!data || !out || len > 1024) return false;
    edgez_mesh_gateway_record_t r = {0};
    bool mac = false, ip = false;
    const uint8_t *p = data, *end = data + len;
    while (p < end) {
        uint64_t key, n;
        if (!varint(&p, end, &key) || !(key >> 3) || key >> 3 > 0x1fffffff) return false;
        unsigned type = key & 7, field = key >> 3;
        if ((field == 1 || field == 3) && type != 2) return false;
        switch (type) {
        case 0: if (!varint(&p, end, &n)) return false; break;
        case 1: if (end - p < 8) return false; p += 8; break;
        case 5: if (end - p < 4) return false; p += 4; break;
        case 2:
            if (!varint(&p, end, &n) || n > (uint64_t)(end - p)) return false;
            if (field == 1) mac = parse_mac(p, n, r.mac);
            if (field == 3) ip = parse_ip(p, n, r.ip);
            p += n; break;
        default: return false;
        }
    }
    if (!mac || !ip) return false;
    r.valid = true; *out = r; return true;
}

static bool decimal(const uint8_t *p, size_t n, uint32_t maximum, uint32_t *out)
{
    if (!n || n > 9) return false;
    uint32_t value = 0;
    for (size_t i = 0; i < n; ++i) {
        if (p[i] < '0' || p[i] > '9') return false;
        value = value * 10 + p[i] - '0';
        if (value > maximum) return false;
    }
    *out = value;
    return true;
}

bool edgez_mesh_gateway_decode_ezgw(const uint8_t *data, size_t len,
                           const uint8_t owner[6], edgez_mesh_gateway_record_t *out)
{
    if (!data || !owner || !out || len > 128 || len < 6 ||
        memcmp(data, "EZGW1 ", 6) || (owner[0] & 1) ||
        !memcmp(owner, (uint8_t[6]){0}, 6)) return false;
    const uint8_t *fields[7];
    size_t lengths[7], pos = 6;
    for (unsigned i = 0; i < 7; ++i) {
        size_t start = pos;
        while (pos < len && data[pos] != ' ') ++pos;
        fields[i] = data + start;
        lengths[i] = pos - start;
        if (!lengths[i] || (i < 6 && pos == len)) return false;
        if (i < 6) ++pos;
    }
    if (pos != len || lengths[0] != 8 || lengths[1] != 8) return false;
    edgez_mesh_gateway_record_t r = {.modern = true};
    memcpy(r.mac, owner, 6);
    for (unsigned i = 0; i < 8; ++i) {
        int a = hex(fields[0][i]), b = hex(fields[1][i]);
        if (a < 0 || b < 0) return false;
        r.session = (r.session << 4) | a;
        r.sequence = (r.sequence << 4) | b;
    }
    uint32_t load, ttl;
    if (!parse_ip(fields[2], lengths[2], r.ip) ||
        !decimal(fields[3], lengths[3], 999999999, &r.down) || !r.down ||
        !decimal(fields[4], lengths[4], 999999999, &r.up) || !r.up ||
        !decimal(fields[5], lengths[5], 100, &load) ||
        !decimal(fields[6], lengths[6], 45, &ttl) || (ttl != 0 && ttl != 45))
        return false;
    r.load = load;
    r.lifetime_ms = ttl * 1000;
    r.valid = ttl != 0;
    *out = r;
    return true;
}

void edgez_mesh_gateway_record(edgez_mesh_gateway_policy_t *s, const edgez_mesh_gateway_record_t *r, uint32_t now)
{
    if (!s || !r || (!r->valid && !r->modern)) return;
    edgez_mesh_gateway_record_t *slot = NULL;
    for (size_t i = 0; i < EDGEZ_MESH_GATEWAY_LIMIT; ++i) {
        edgez_mesh_gateway_record_t *c = &s->records[i];
        if ((c->valid || c->modern) && !memcmp(c->mac, r->mac, 6)) { slot = c; break; }
        if (!slot || (!c->valid && !c->modern) || ((slot->valid || slot->modern) &&
            (uint32_t)(now - c->updated_ms) > (uint32_t)(now - slot->updated_ms))) slot = c;
    }
    bool same = !memcmp(slot->mac, r->mac, 6);
    if (same && slot->modern && !r->modern) return;
    if (r->modern) {
        bool same_session = same && slot->modern && slot->session == r->session;
        uint32_t delta = r->sequence - slot->sequence;
        if (same_session && (!delta || delta >= 0x80000000U)) return;
        *slot = *r;
        /* A cached first sample is not proof that the publisher is alive. */
        slot->valid = same_session && r->valid;
    } else {
        *slot = *r;
    }
    slot->updated_ms = now;
}

bool edgez_mesh_gateway_select(edgez_mesh_gateway_policy_t *s, const edgez_mesh_gateway_route_t *routes,
                       size_t count, uint32_t now)
{
    edgez_mesh_gateway_record_t best = {0}, current = {0};
    uint64_t best_score = 0, current_score = 0;
    for (size_t i = 0; i < count; ++i) {
        const edgez_mesh_gateway_route_t *r = &routes[i];
        if (!r->gateway || !r->tq) continue;
        for (size_t j = 0; j < EDGEZ_MESH_GATEWAY_LIMIT; ++j) {
            const edgez_mesh_gateway_record_t *c = &s->records[j];
            if (!c->valid || memcmp(c->mac, r->mac, 6) ||
                (uint32_t)(now - c->updated_ms) >=
                    (c->modern ? c->lifetime_ms : EDGEZ_MESH_GATEWAY_RECORD_TTL_MS)) continue;
            if (!c->modern && (!r->down || !r->up)) continue;
            uint32_t capacity = c->modern ? (c->down < c->up ? c->down : c->up) : r->down;
            uint32_t available = c->modern && c->load < 100 ? 100 - c->load : 1;
            uint64_t score = (uint64_t)r->tq * r->tq * capacity * available;
            if (!best.valid || score > best_score ||
                (score == best_score && memcmp(c->mac, best.mac, 6) < 0)) {
                best = *c; best_score = score;
            }
            if (s->selected.valid && !memcmp(s->selected.mac, c->mac, 6)) {
                current = *c; current_score = score;
            }
        }
    }
    if (current.valid && ((uint32_t)(now - s->selected_ms) < EDGEZ_MESH_GATEWAY_HOLD_MS ||
                          best_score * 5 <= current_score * 6)) best = current;
    bool changed = best.valid != s->selected.valid ||
                   (best.valid && (memcmp(best.mac, s->selected.mac, 6) ||
                                   memcmp(best.ip, s->selected.ip, 4)));
    s->selected = best;
    if (changed) s->selected_ms = now;
    return changed;
}
