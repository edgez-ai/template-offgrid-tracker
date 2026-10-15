#ifndef EDGEZ_BLE_H
#define EDGEZ_BLE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int edgez_ble_start(void);
void edgez_ble_stop(void);
void edgez_ble_process(void);
bool edgez_ble_is_connected(void);
bool edgez_ble_can_notify(void);
bool edgez_ble_is_enabled(void);
void edgez_ble_update_battery(uint8_t level);
int edgez_ble_notify_packet(const uint8_t *payload, size_t payload_len);

#endif
