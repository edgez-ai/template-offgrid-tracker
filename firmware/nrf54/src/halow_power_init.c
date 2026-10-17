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
#include <zephyr/pm/device.h>

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
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static const struct device *const halow_spi =
	DEVICE_DT_GET(DT_BUS(DT_NODELABEL(morse_wifi)));
static bool halow_spi_suspended;
static const struct gpio_dt_spec halow_cs =
	GPIO_DT_SPEC_GET(DT_BUS(DT_NODELABEL(morse_wifi)), cs_gpios);
static const struct gpio_dt_spec halow_reset =
	GPIO_DT_SPEC_GET(DT_NODELABEL(morse_wifi), resetn_gpios);
static const struct gpio_dt_spec halow_wake =
	GPIO_DT_SPEC_GET(DT_NODELABEL(morse_wifi), wakeup_gpios);
static const struct gpio_dt_spec halow_irq =
	GPIO_DT_SPEC_GET(DT_NODELABEL(morse_wifi), spi_irq_gpios);
static const struct gpio_dt_spec halow_busy =
	GPIO_DT_SPEC_GET(DT_NODELABEL(morse_wifi), busy_gpios);

static int halow_control_pins(bool powered)
{
	/* SPI PM only manages SCK/MOSI/MISO, not GPIO CS or radio controls.
	 * Keep reset asserted until the radio driver starts the next cycle. */
	int rc = gpio_pin_configure_dt(&halow_reset,
		powered ? GPIO_OUTPUT_ACTIVE : GPIO_DISCONNECTED);
	if (rc != 0) {
		return rc;
	}
	rc = gpio_pin_configure_dt(&halow_wake,
		powered ? GPIO_OUTPUT_ACTIVE : GPIO_DISCONNECTED);
	if (rc != 0) {
		return rc;
	}
	rc = gpio_pin_configure_dt(&halow_cs,
		powered ? GPIO_OUTPUT_INACTIVE : GPIO_DISCONNECTED);
	if (rc != 0) {
		return rc;
	}
	/* Remove the driver's IRQ pull-up and BUSY pull-down while the module supply
	 * is absent. This mirrors the verified all-off reference and prevents the
	 * unpowered module from biasing MCU input structures. */
	rc = gpio_pin_configure_dt(&halow_irq,
		powered ? (GPIO_INPUT | GPIO_PULL_UP) : GPIO_DISCONNECTED);
	if (rc != 0) {
		return rc;
	}
	return gpio_pin_configure_dt(&halow_busy,
		powered ? (GPIO_INPUT | GPIO_PULL_DOWN) : GPIO_DISCONNECTED);
}
#endif

bool edgez_halow_power_is_ready(void)
{
	return halow_power_ready;
}

int edgez_halow_power_set(bool enabled)
{
#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, halow_power_en_gpios)
	if (!gpio_is_ready_dt(&halow_power_en)) {
		return -ENODEV;
	}
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	/* The caller has stopped the radio and its workers before rail cutoff.
	 * Suspend SPIM while the module is still powered, then isolate CS and
	 * apply the bus's sleep pinctrl state. */
	if (!enabled && !halow_spi_suspended) {
		int rc = pm_device_action_run(halow_spi, PM_DEVICE_ACTION_SUSPEND);
		if (rc != 0 && rc != -EALREADY) {
			LOG_ERR("HaLow SPI suspend failed rc=%d", rc);
			return rc;
		}
		halow_spi_suspended = true;
	}
	if (!enabled) {
		int rc = gpio_pin_interrupt_configure_dt(&halow_irq, GPIO_INT_DISABLE);
		if (rc == 0) {
			rc = halow_control_pins(false);
		}
		if (rc != 0) {
			LOG_ERR("HaLow pin isolation failed rc=%d", rc);
			return rc;
		}
	}
#endif
	int status = gpio_pin_set_dt(&halow_power_en, enabled ? 1 : 0);

	if (status < 0) {
		LOG_ERR("failed to %s HaLow power rail: %d",
			enabled ? "enable" : "disable", status);
		return status;
	}
	/* MM8108 needs its supply and reset domain to settle before SPI access. */
	k_msleep(enabled ? 500 : 100);
	halow_power_ready = enabled;
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	/* Restore bus pins only after the radio supply has settled. */
	if (enabled && halow_spi_suspended) {
		int rc = halow_control_pins(true);
		if (rc == 0) {
			rc = pm_device_action_run(halow_spi, PM_DEVICE_ACTION_RESUME);
		}
		if (rc != 0 && rc != -EALREADY) {
			(void)halow_control_pins(false);
			(void)gpio_pin_set_dt(&halow_power_en, 0);
			halow_power_ready = false;
			LOG_ERR("HaLow SPI resume failed rc=%d", rc);
			return rc;
		}
		halow_spi_suspended = false;
	}
#endif
	LOG_INF("HaLow power rail %s", enabled ? "enabled" : "disabled");
	return 0;
#else
	if (!enabled) {
		return -ENOTSUP;
	}
	halow_power_ready = true;
	return 0;
#endif
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

	status = edgez_halow_power_set(true);
	if (status < 0) {
		return status;
	}
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
