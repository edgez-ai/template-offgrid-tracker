#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

/* MQTT relay ABI exported by the protected ESP platform archive. */
typedef int (*mesh_mqtt_publish_fn_t)(const char *, const void *, size_t, int, bool);
typedef void (*mesh_mqtt_command_fn_t)(const char *, const uint8_t *, size_t);
esp_err_t edgez_mqtt_init(bool gateway, const char *serial,
                          mesh_mqtt_publish_fn_t publish, mesh_mqtt_command_fn_t command);
void edgez_mqtt_set_gateway_online(bool online);
void edgez_mqtt_set_local_mac(const uint8_t mac[6]);
bool edgez_mqtt_gateway_available(void);
int edgez_mqtt_publish_system_status(const void *payload, size_t length, int qos, bool retain);
int edgez_mqtt_publish_telemetry(const void *payload, size_t length, int qos, bool retain);
