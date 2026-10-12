#include "edgez_battery.h"

#include <errno.h>

#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/regulator.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

LOG_MODULE_REGISTER(edgez_battery, LOG_LEVEL_INF);

#define BATTERY_NODE DT_PATH(zephyr_user)
#define BATTERY_GPIO_CONTROL \
	DT_NODE_HAS_PROP(BATTERY_NODE, battery_enable_gpios)
#if !BATTERY_GPIO_CONTROL && defined(CONFIG_BOARD_XIAO_NRF54L15)
#define BATTERY_REGULATOR_NODE DT_NODELABEL(vbat_pwr)
#define BATTERY_REGULATOR_CONTROL \
	DT_NODE_HAS_STATUS(BATTERY_REGULATOR_NODE, okay)
#else
#define BATTERY_REGULATOR_CONTROL 0
#endif
#define BATTERY_SUPPORTED \
	(DT_NODE_HAS_PROP(BATTERY_NODE, io_channels) && \
	 (BATTERY_GPIO_CONTROL || BATTERY_REGULATOR_CONTROL))
#define BATTERY_DIVIDER_MULTIPLIER 2
#define BATTERY_SAMPLE_INTERVAL_MS 15000

#if BATTERY_SUPPORTED
static const struct adc_dt_spec battery_adc = ADC_DT_SPEC_GET_BY_IDX(BATTERY_NODE, 0);
#if BATTERY_GPIO_CONTROL
static const struct gpio_dt_spec battery_enable =
	GPIO_DT_SPEC_GET(BATTERY_NODE, battery_enable_gpios);
#else
static const struct device *const battery_regulator =
	DEVICE_DT_GET(BATTERY_REGULATOR_NODE);
#endif
static bool ready;
static int32_t cached_mv;
static int64_t last_sample_ms;
static atomic_t async_sample_pending;

static void battery_sample_work_handler(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(battery_sample_work, battery_sample_work_handler);
#endif

#if BATTERY_SUPPORTED
static int battery_power_enable(void)
{
#if BATTERY_GPIO_CONTROL
	return gpio_pin_set_dt(&battery_enable, 1);
#else
	return regulator_enable(battery_regulator);
#endif
}

static void battery_power_disable(void)
{
#if BATTERY_GPIO_CONTROL
	(void)gpio_pin_set_dt(&battery_enable, 0);
#else
	(void)regulator_disable(battery_regulator);
#endif
}

static int battery_adc_finish_sample(int32_t *millivolts)
{
	struct adc_sequence sequence = {0};
	int16_t raw = 0;
	int32_t input_mv;
	int rc;

	rc = adc_sequence_init_dt(&battery_adc, &sequence);
	if (rc == 0) {
		sequence.buffer = &raw;
		sequence.buffer_size = sizeof(raw);
		rc = adc_read_dt(&battery_adc, &sequence);
	}
	battery_power_disable();
	if (rc != 0) {
		LOG_WRN("Battery ADC read failed: %d", rc);
		return rc;
	}
	input_mv = raw;
	rc = adc_raw_to_millivolts_dt(&battery_adc, &input_mv);
	if (rc != 0) return rc;
	if (input_mv < 0 || input_mv > 2400) return -ERANGE;
	cached_mv = input_mv * BATTERY_DIVIDER_MULTIPLIER;
	last_sample_ms = k_uptime_get();
	if (millivolts) {
		*millivolts = cached_mv;
	}
	LOG_DBG("Battery voltage %d mV", cached_mv);
	return 0;
}

static void battery_sample_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	(void)battery_adc_finish_sample(NULL);
	atomic_clear(&async_sample_pending);
}
#endif

int edgez_battery_init(void)
{
#if BATTERY_SUPPORTED
	int32_t initial_mv;
	int rc;

	if (!adc_is_ready_dt(&battery_adc)) {
		return -ENODEV;
	}
#if BATTERY_GPIO_CONTROL
	if (!gpio_is_ready_dt(&battery_enable)) return -ENODEV;
	rc = gpio_pin_configure_dt(&battery_enable, GPIO_OUTPUT_INACTIVE);
	if (rc != 0) return rc;
#else
	if (!device_is_ready(battery_regulator)) return -ENODEV;
#endif
	rc = adc_channel_setup_dt(&battery_adc);
	if (rc != 0) {
		LOG_ERR("Battery ADC channel setup failed: %d", rc);
		return rc;
	}
	ready = true;
	/* Prime the cache during boot, while the application already waits before
	 * starting HaLow. Sleepy request construction can then remain non-blocking. */
	rc = edgez_battery_read_mv(&initial_mv);
	if (rc != 0) {
		LOG_WRN("Initial battery ADC read failed: %d", rc);
	}
	return 0;
#else
	return -ENOTSUP;
#endif
}

int edgez_battery_read_cached_mv(int32_t *millivolts)
{
#if BATTERY_SUPPORTED
	if (!millivolts || !ready) return -ENODEV;
	if (last_sample_ms == 0) return -EAGAIN;
	*millivolts = cached_mv;
	return 0;
#else
	ARG_UNUSED(millivolts);
	return -ENOTSUP;
#endif
}

int edgez_battery_refresh_async(void)
{
#if BATTERY_SUPPORTED
	int rc;

	if (!ready) return -ENODEV;
	if (!atomic_cas(&async_sample_pending, 0, 1)) return -EALREADY;
	rc = battery_power_enable();
	if (rc != 0) {
		atomic_clear(&async_sample_pending);
		return rc;
	}
	rc = k_work_reschedule(&battery_sample_work, K_MSEC(100));
	if (rc < 0) {
		battery_power_disable();
		atomic_clear(&async_sample_pending);
		return rc;
	}
	return 0;
#else
	return -ENOTSUP;
#endif
}

int edgez_battery_read_mv(int32_t *millivolts)
{
#if BATTERY_SUPPORTED
	int rc;
	int64_t now = k_uptime_get();

	if (!millivolts || !ready) return -ENODEV;
	if (last_sample_ms > 0 && now - last_sample_ms < BATTERY_SAMPLE_INTERVAL_MS) {
		*millivolts = cached_mv;
		return 0;
	}
	rc = battery_power_enable();
	if (rc != 0) return rc;
	/* Seeed's reference sequence allows the switched divider to settle. */
	k_msleep(100);
	return battery_adc_finish_sample(millivolts);
#else
	ARG_UNUSED(millivolts);
	return -ENOTSUP;
#endif
}
