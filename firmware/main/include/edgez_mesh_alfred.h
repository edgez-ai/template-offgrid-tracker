#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "edgez_mesh_gateway_policy.h"

#ifdef __cplusplus
extern "C" {
#endif

void edgez_mesh_alfred_gateway_tick(void);
/* Refresh or withdraw our IPv4 SoftAP route (upstream==0 withdraws). */
void edgez_mesh_alfred_subnet_tick(uint32_t upstream, uint32_t router, uint32_t mask);
void edgez_mesh_alfred_set_hostname(const char *hostname);
const char *edgez_mesh_alfred_get_hostname(void);
bool edgez_mesh_alfred_select_gateway(const edgez_mesh_gateway_route_t *routes,
                                     size_t count, uint32_t now,
                                     edgez_mesh_gateway_record_t *selected);
void edgez_mesh_alfred_handle_frame(const uint8_t originator[6],
                                   const uint8_t *frame, size_t frame_len);

#ifdef __cplusplus
}
#endif
