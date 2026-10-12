#pragma once
#include <stddef.h>
#include <stdint.h>

/* Returns an Ethernet Neighbor Advertisement, or zero for invalid/unrelated NS.
 * Input and output must not overlap. No allocation or platform dependencies. */
#define EDGEZ_MESH_NDP_REPLY_LEN 86
/* Proactively advertise our link-local address to all nodes. */
size_t edgez_mesh_ndp_advertisement(const uint8_t mac[6], const uint8_t peer_mac[6],
                            const uint8_t peer_ip[16], uint8_t *reply,
                            size_t capacity);
size_t edgez_mesh_ndp_reply(const uint8_t mac[6], const uint8_t *frame, size_t len,
                    uint8_t *reply, size_t capacity);
