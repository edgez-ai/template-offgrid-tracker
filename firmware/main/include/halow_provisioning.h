#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char client_id[64];
    char mesh_id[33];
    char passphrase[64];
    char country[3];
    uint8_t channel;
    bool wifi_upstream;
} halow_provisioning_config_t;

/** Initialize NVS, loading the saved HaLow profile when one exists. */
esp_err_t halow_provisioning_init(halow_provisioning_config_t *config,
                                  bool *provisioned);

/** Start the EdgeZ-compatible ESP32 BLE provisioning service. */
esp_err_t halow_provisioning_start(void);

/** Resolve a provisioned S1G channel to its center frequency and bandwidth. */
esp_err_t halow_provisioning_resolve_channel(const char country[3],
                                             uint8_t channel,
                                             uint32_t *frequency_khz,
                                             uint8_t *bandwidth_mhz);

#ifdef __cplusplus
}
#endif
