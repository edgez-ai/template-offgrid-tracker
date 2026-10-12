#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define EDGEZ_MESH_GATEWAY_LIMIT 16
#define EDGEZ_MESH_GATEWAY_RECORD_TTL_MS 180000U
#define EDGEZ_MESH_GATEWAY_HOLD_MS 10000U

typedef struct {
    uint8_t mac[6];
    uint8_t ip[4];
    uint32_t updated_ms;
    bool valid;
    bool modern;
    uint32_t session, sequence, lifetime_ms;
    uint32_t down, up;
    uint8_t load;
} edgez_mesh_gateway_record_t;

typedef struct {
    uint8_t mac[6];
    uint8_t tq;
    uint32_t down, up;
    bool gateway;
} edgez_mesh_gateway_route_t;

typedef struct {
    edgez_mesh_gateway_record_t records[EDGEZ_MESH_GATEWAY_LIMIT];
    edgez_mesh_gateway_record_t selected;
    uint32_t selected_ms;
} edgez_mesh_gateway_policy_t;

/* EdgeZ Mesh Network Gateway protobuf: mac=1, hostname=2, ipaddr=3 (strings).
 * Decode bounded wire data without heap allocation; unknown fields are skipped. */
bool edgez_mesh_gateway_decode(const uint8_t *data, size_t len, edgez_mesh_gateway_record_t *out);
/* Alfred 105/version 0 EZGW1; owner must be resolved to its BATMAN originator. */
bool edgez_mesh_gateway_decode_ezgw(const uint8_t *data, size_t len,
                           const uint8_t owner[6], edgez_mesh_gateway_record_t *out);
void edgez_mesh_gateway_record(edgez_mesh_gateway_policy_t *s, const edgez_mesh_gateway_record_t *record,
                       uint32_t now);
/* Picks only routes with a fresh IPv4 mapping. Keeps the incumbent unless a
 * challenger is >20% better after a hold period; invalid incumbents fail over
 * immediately. Returns true when MAC, IP, or availability changes. */
bool edgez_mesh_gateway_select(edgez_mesh_gateway_policy_t *s, const edgez_mesh_gateway_route_t *routes,
                       size_t count, uint32_t now);
