/*
 * Copyright 2026 EdgeZeron AI AB
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <stdbool.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(edgez_halow_power, LOG_LEVEL_INF);

#define EDGEZ_USER_NODE DT_PATH(zephyr_user)
#define EDGEZ_HALOW_POWER_INIT_PRIORITY 79

BUILD_ASSERT(CONFIG_GPIO_INIT_PRIORITY < EDGEZ_HALOW_POWER_INIT_PRIORITY);
BUILD_ASSERT(EDGEZ_HALOW_POWER_INIT_PRIORITY < CONFIG_WIFI_INIT_PRIORITY);

#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, halow_power_en_gpios)
static const struct gpio_dt_spec halow_power_en =
	GPIO_DT_SPEC_GET(EDGEZ_USER_NODE, halow_power_en_gpios);
#elif !DT_NODE_HAS_PROP(EDGEZ_USER_NODE, halow_always_powered)
#error "Join-only image requires halow-power-en-gpios or halow-always-powered"
#endif

static bool halow_power_ready;

bool edgez_halow_power_is_ready(void)
{
	return halow_power_ready;
}

static int edgez_halow_power_init(void)
{
#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, halow_power_en_gpios)
	if (!gpio_is_ready_dt(&halow_power_en)) {
		LOG_ERR("HaLow power-enable GPIO is not ready");
		return -ENODEV;
	}

	int status = gpio_pin_configure_dt(&halow_power_en,
					   GPIO_OUTPUT_INACTIVE);
	if (status < 0) {
		LOG_ERR("failed to disable HaLow power rail: %d", status);
		return status;
	}
	k_msleep(100);

	status = gpio_pin_set_dt(&halow_power_en, 1);
	if (status < 0) {
		LOG_ERR("failed to enable HaLow power rail: %d", status);
		return status;
	}
	k_msleep(500);
	halow_power_ready = true;
	LOG_INF("HaLow power ready before Morse init on GPIO %s pin %u",
		halow_power_en.port->name, halow_power_en.pin);
#else
	halow_power_ready = true;
	LOG_INF("HaLow shield is always powered");
#endif
	return 0;
}

SYS_INIT(edgez_halow_power_init, POST_KERNEL,
	 EDGEZ_HALOW_POWER_INIT_PRIORITY);
