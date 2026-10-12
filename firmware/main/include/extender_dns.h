#pragma once
#include "lwip/netif.h"
#include "lwip/ip_addr.h"
/* lwIP-thread only. Stops accepting requests when enabled is false. */
bool extender_dns_update(struct netif *mesh, struct netif *upstream,
                         const ip_addr_t *resolver, bool enabled);
