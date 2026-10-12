#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_netif.h"
#ifdef __cplusplus
extern "C" {
#endif
/* HaLow upstream with a downstream Wi-Fi SoftAP. */
esp_err_t edgez_mesh_internet_start(esp_netif_t *softap);
esp_err_t edgez_mesh_internet_start_gateway(esp_netif_t *wifi);
uint32_t edgez_mesh_internet_ready_ip(void);
/* Called by the Wi-Fi/IP event handler. A disconnect immediately withdraws
 * the BATMAN gateway flag; DHCP acquisition wakes the forwarding worker,
 * which advertises only after DNS, DHCP and NAPT are ready. */
void edgez_mesh_internet_wifi_upstream_changed(bool has_ip);
bool edgez_mesh_internet_gateway_advertised(void);
bool edgez_mesh_internet_handle_frame(const uint8_t *frame, size_t len);
#ifdef __cplusplus
}
#endif
