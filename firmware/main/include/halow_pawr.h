#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*halow_pawr_beacon_callback_t)(const uint8_t source_mac[6],
                                             const uint8_t *beacon,
                                             size_t length,
                                             int16_t rssi_dbm,
                                             void *arg);

/** Start the EdgeZ Wi-Fi HaLow PAwR vendor-action receiver. */
esp_err_t halow_pawr_start(halow_pawr_beacon_callback_t callback, void *arg);

/** Send the PAwR beacon-response acknowledgement used by the internal firmware. */
esp_err_t halow_pawr_ack_beacon(const uint8_t destination_mac[6],
                               const uint8_t *beacon,
                               size_t length);

#ifdef __cplusplus
}
#endif
