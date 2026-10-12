#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "lwip/netif.h"
/* Call only on the lwIP thread. */
void edgez_mesh_iperf_update(struct netif *mesh, struct netif *wifi_upstream,
                            bool ready, uint32_t generation);
bool edgez_mesh_iperf_ready(void);
