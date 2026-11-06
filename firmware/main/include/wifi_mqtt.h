#pragma once

#include "halow_provisioning.h"

/** Start native Wi-Fi using the ESP provisioning manager's saved STA config. */
esp_err_t wifi_mqtt_start(const halow_provisioning_config_t *config);
bool wifi_mqtt_ready(void *arg);
void wifi_mqtt_relay_started(void);
int wifi_mqtt_publish_block(const uint8_t source_mac[6], const void *payload, size_t length);
int wifi_mqtt_publish(const char *topic, const void *payload, size_t length,
                      int qos, bool retain, void *arg);
