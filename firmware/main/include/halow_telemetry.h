#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int (*halow_telemetry_publish_fn_t)(const char *topic,
                                            const void *payload,
                                            size_t length,
                                            int qos,
                                            bool retain,
                                            void *arg);
typedef bool (*halow_telemetry_ready_fn_t)(void *arg);

/** Decode an EdgeZ PAwR Beacon protobuf and publish its sensor JSON. */
esp_err_t halow_telemetry_forward_beacon(const uint8_t *beacon, size_t length);

/**
 * Start local telemetry using an application-selected MQTT publisher.
 * The publisher may use the BATMAN relay or a direct Wi-Fi MQTT client.
 */
esp_err_t halow_telemetry_start_local(const char *client_id,
                                      const uint8_t halow_mac[6],
                                      uint8_t channel,
                                      uint32_t frequency_khz,
                                      uint8_t bandwidth_mhz,
                                      bool publish_system_status,
                                      bool batman_metrics,
                                      halow_telemetry_publish_fn_t publish_fn,
                                      halow_telemetry_ready_fn_t ready_fn,
                                      void *publisher_arg);

#ifdef __cplusplus
}
#endif
