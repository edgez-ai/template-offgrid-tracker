#ifndef EDGEZ_PAWR_H
#define EDGEZ_PAWR_H

#include <stdbool.h>
#include <stdint.h>

/* Register the sleepy-device request protocol after the Morse radio boots. */
int edgez_pawr_init(void);

/* Send the current Beacon to the always-on ESP32. */
int edgez_pawr_send_beacon_request(uint32_t wake_interval_ms);

/* Wait for the ESP32 response to the most recent request. */
bool edgez_pawr_wait_for_response(uint32_t timeout_ms);

#endif
