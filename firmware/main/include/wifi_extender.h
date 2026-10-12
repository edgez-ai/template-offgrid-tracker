#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* Start once after the BATMAN mesh service. Uses saved Wi-Fi STA credentials
 * for gateway mode; otherwise creates the downstream EZ-<MAC> SoftAP. */
esp_err_t wifi_extender_start(const uint8_t mesh_mac[6], bool gateway);
bool wifi_extender_is_gateway(void);
