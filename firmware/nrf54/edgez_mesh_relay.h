#ifndef EDGEZ_MESH_RELAY_H
#define EDGEZ_MESH_RELAY_H

#include <stddef.h>
#include <stdint.h>

int edgez_nrf_relay_init(const uint8_t local_mac[6]);
int edgez_nrf_relay_send(const uint8_t destination[6], const uint8_t *payload,
			 size_t payload_len);
void edgez_nrf_relay_reset(void);

#endif
