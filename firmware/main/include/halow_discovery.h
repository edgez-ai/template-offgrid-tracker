#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void halow_discovery_tick(void);
/** True when the payload is a validated discovery, rather than sensor data. */
bool halow_discovery_receive(const uint8_t source[6], const uint8_t *payload, size_t length);
/** Cache an opaque encrypted acceptance received from Appwrite Devices. */
bool halow_discovery_accept(const uint8_t *payload, size_t length);
