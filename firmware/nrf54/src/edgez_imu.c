#include "edgez_imu.h"

#include <errno.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/reboot.h>

LOG_MODULE_REGISTER(edgez_imu, LOG_LEVEL_INF);

#define EDGEZ_IMU_SAMPLE_RATE_HZ 12
#define EDGEZ_IMU_SETTLE_MS 100
#define EDGEZ_IMU_RESTART_FAILURE_LIMIT 20U
#define EDGEZ_IMU_HALOW_TX_QUIET_MS 100U
#if defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
#define EDGEZ_IMU_FIFO_WATERMARK_SAMPLES 48U
#define EDGEZ_IMU_FIFO_DMA_SAMPLES 48U
#define EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE 3U
#define EDGEZ_IMU_FIFO_BYTES_PER_SAMPLE 6U
#else
#define EDGEZ_IMU_FIFO_WATERMARK_SAMPLES 32U
#define EDGEZ_IMU_FIFO_DMA_SAMPLES 16U
#define EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE 6U
#define EDGEZ_IMU_FIFO_BYTES_PER_SAMPLE 12U
#endif
#define EDGEZ_IMU_FIFO_WATERMARK_WORDS \
	(EDGEZ_IMU_FIFO_WATERMARK_SAMPLES * EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE)
#define EDGEZ_IMU_FIFO_DMA_WORDS \
	(EDGEZ_IMU_FIFO_DMA_SAMPLES * EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE)
#define EDGEZ_IMU_FIFO_BUFFER_BYTES \
	(EDGEZ_IMU_FIFO_DMA_SAMPLES * EDGEZ_IMU_FIFO_BYTES_PER_SAMPLE)
#define EDGEZ_IMU_FIFO_FALLBACK_MS 15000U
#define EDGEZ_IMU_WHO_AM_I_REG 0x0FU
#define EDGEZ_IMU_WHO_AM_I_VALUE 0x6AU
#define EDGEZ_IMU_CTRL1_XL_REG 0x10U
#define EDGEZ_IMU_CTRL2_G_REG 0x11U
#define EDGEZ_IMU_CTRL3_C_REG 0x12U
#define EDGEZ_IMU_CTRL6_C_REG 0x15U
#define EDGEZ_IMU_CTRL7_G_REG 0x16U
#define EDGEZ_IMU_FIFO_CTRL1_REG 0x06U
#define EDGEZ_IMU_FIFO_CTRL2_REG 0x07U
#define EDGEZ_IMU_FIFO_CTRL3_REG 0x08U
#define EDGEZ_IMU_FIFO_CTRL5_REG 0x0AU
#define EDGEZ_IMU_INT1_CTRL_REG 0x0DU
#define EDGEZ_IMU_FIFO_STATUS1_REG 0x3AU
#define EDGEZ_IMU_FIFO_DATA_OUT_L_REG 0x3EU
#define EDGEZ_IMU_CTRL3_SW_RESET BIT(0)
#define EDGEZ_IMU_CTRL3_IF_INC BIT(2)
#define EDGEZ_IMU_CTRL3_BDU BIT(6)
#define EDGEZ_IMU_ODR_12_5_HZ BIT(4)
#define EDGEZ_IMU_GYRO_FS_125_DPS BIT(1)
#define EDGEZ_IMU_INT1_FIFO_THRESHOLD BIT(3)
#define EDGEZ_IMU_FIFO_NO_DECIMATION 1U
#define EDGEZ_IMU_FIFO_ODR_12_5_HZ BIT(3)
#define EDGEZ_IMU_FIFO_CONTINUOUS_MODE 6U
#define EDGEZ_IMU_FIFO_STATUS_OVERRUN BIT(6)
#define EDGEZ_IMU_ACCEL_M_S2_PER_LSB 0.00059820565f
#define EDGEZ_IMU_GYRO_RAD_S_PER_LSB 0.00007635815f
#define EDGEZ_IMU_RESET_TIMEOUT_MS 50U
#define EDGEZ_IMU_BUS_RECOVERY_SETTLE_MS 10U

K_MUTEX_DEFINE(imu_lock);

#if DT_HAS_ALIAS(imu0) && DT_NODE_HAS_STATUS(DT_ALIAS(imu0), okay)
static const struct i2c_dt_spec imu_i2c = I2C_DT_SPEC_GET(DT_ALIAS(imu0));
#else
static const struct i2c_dt_spec imu_i2c;
#endif

#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN) && \
	DT_HAS_ALIAS(imu0) && DT_NODE_HAS_PROP(DT_ALIAS(imu0), irq_gpios)
static const struct gpio_dt_spec imu_irq =
	GPIO_DT_SPEC_GET(DT_ALIAS(imu0), irq_gpios);
#elif !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static const struct gpio_dt_spec imu_irq;
#endif

static bool imu_ready;
static bool imu_sample_valid;
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static bool imu_i2c_suspended;
#endif
#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static bool imu_irq_registered;
static uint32_t imu_sample_failure_count;
#endif
static atomic_t halow_last_tx_ms;
static struct edgez_imu_sample latest_sample;
#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static struct gpio_callback imu_irq_callback;
#endif
static uint8_t fifo_raw[EDGEZ_IMU_FIFO_BUFFER_BYTES];

#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static int imu_i2c_set_active(bool active)
{
	int rc;

	if (!imu_i2c.bus || active == !imu_i2c_suspended) {
		return 0;
	}
	rc = pm_device_action_run(imu_i2c.bus,
		active ? PM_DEVICE_ACTION_RESUME : PM_DEVICE_ACTION_SUSPEND);
	if (rc != 0 && rc != -EALREADY) {
		return rc;
	}
	imu_i2c_suspended = !active;
	return 0;
}
#endif

#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static void imu_sample_work_handler(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(imu_sample_work, imu_sample_work_handler);

static void imu_irq_handler(const struct device *port,
			    struct gpio_callback *callback, uint32_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	(void)k_work_reschedule(&imu_sample_work, K_NO_WAIT);
}
#endif

static uint32_t halow_tx_quiet_remaining_ms(void)
{
	uint32_t last_tx_ms = (uint32_t)atomic_get(&halow_last_tx_ms);
	uint32_t elapsed_ms;

	if (last_tx_ms == 0U) {
		return 0U;
	}
	elapsed_ms = k_uptime_get_32() - last_tx_ms;
	return elapsed_ms < EDGEZ_IMU_HALOW_TX_QUIET_MS ?
		EDGEZ_IMU_HALOW_TX_QUIET_MS - elapsed_ms : 0U;
}

void edgez_imu_note_halow_tx(void)
{
	atomic_set(&halow_last_tx_ms, (atomic_val_t)k_uptime_get_32());
}

bool edgez_imu_halow_tx_quiet(void)
{
	return halow_tx_quiet_remaining_ms() == 0U;
}

static int set_sampling_rate(int hz)
{
	uint8_t accel_ctrl = hz > 0 ? EDGEZ_IMU_ODR_12_5_HZ : 0U;
#if defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
	uint8_t gyro_ctrl = 0U;
#else
	uint8_t gyro_ctrl = hz > 0 ?
		EDGEZ_IMU_ODR_12_5_HZ | EDGEZ_IMU_GYRO_FS_125_DPS : 0U;
#endif
	int rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL1_XL_REG,
				       accel_ctrl);

	if (rc < 0) {
		return rc;
	}
	return i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL2_G_REG,
				      gyro_ctrl);
}

static int configure_fifo(void)
{
	int rc;

#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	if (!imu_irq.port || !gpio_is_ready_dt(&imu_irq)) {
		return -ENODEV;
	}
	rc = gpio_pin_configure_dt(&imu_irq, GPIO_INPUT);
	if (rc < 0) {
		return rc;
	}
	if (!imu_irq_registered) {
		gpio_init_callback(&imu_irq_callback, imu_irq_handler, BIT(imu_irq.pin));
		rc = gpio_add_callback(imu_irq.port, &imu_irq_callback);
		if (rc < 0) {
			return rc;
		}
		imu_irq_registered = true;
	}
#endif

	/* The FIFO watermark is expressed in 16-bit words. */
	rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_FIFO_CTRL1_REG,
				     EDGEZ_IMU_FIFO_WATERMARK_WORDS & 0xffU);
	if (rc == 0) {
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_FIFO_CTRL2_REG,
					     (EDGEZ_IMU_FIFO_WATERMARK_WORDS >> 8) & 0x07U);
	}
	if (rc == 0) {
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_FIFO_CTRL3_REG,
#if defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
					     EDGEZ_IMU_FIFO_NO_DECIMATION);
#else
					     (EDGEZ_IMU_FIFO_NO_DECIMATION << 3) |
					     EDGEZ_IMU_FIFO_NO_DECIMATION);
#endif
	}
	if (rc == 0) {
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_INT1_CTRL_REG,
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
					     0U);
#else
					     EDGEZ_IMU_INT1_FIFO_THRESHOLD);
#endif
	}
	if (rc == 0) {
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_FIFO_CTRL5_REG,
					     EDGEZ_IMU_FIFO_ODR_12_5_HZ |
					     EDGEZ_IMU_FIFO_CONTINUOUS_MODE);
	}
	if (rc == 0) {
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
		return 0;
#else
		rc = gpio_pin_interrupt_configure_dt(&imu_irq, GPIO_INT_EDGE_TO_ACTIVE);
#endif
	}
	return rc;
}

static int imu_configure(void)
{
	uint8_t chip_id = 0U;
	uint8_t ctrl3;
	int recovery_rc;
	int rc;

	if (!imu_i2c.bus || !device_is_ready(imu_i2c.bus)) {
		return -ENODEV;
	}

	rc = i2c_reg_read_byte_dt(&imu_i2c, EDGEZ_IMU_WHO_AM_I_REG, &chip_id);
	if (rc < 0) {
		/* A warm MCU reboot does not power-cycle the IMU. If reset happens
		 * during a transfer, the peripheral can retain a partial I2C
		 * transaction and hold the bus until it sees recovery clocks. A
		 * plain delayed WHO_AM_I retry cannot clear that state. */
		recovery_rc = i2c_recover_bus(imu_i2c.bus);
		if (recovery_rc == 0) {
			k_msleep(EDGEZ_IMU_BUS_RECOVERY_SETTLE_MS);
			rc = i2c_reg_read_byte_dt(&imu_i2c,
					      EDGEZ_IMU_WHO_AM_I_REG, &chip_id);
			if (rc == 0) {
				LOG_INF("IMU I2C bus recovered after WHO_AM_I failure");
			}
		}
		if (rc < 0) {
			LOG_WRN("IMU WHO_AM_I read failed bus=%s addr=0x%02x rc=%d recovery_rc=%d",
				imu_i2c.bus->name, imu_i2c.addr, rc, recovery_rc);
			return rc;
		}
	}
	if (chip_id != EDGEZ_IMU_WHO_AM_I_VALUE) {
		LOG_WRN("Unexpected IMU WHO_AM_I bus=%s addr=0x%02x got=0x%02x expected=0x%02x",
			imu_i2c.bus->name, imu_i2c.addr, chip_id,
			EDGEZ_IMU_WHO_AM_I_VALUE);
		return -ENODEV;
	}

	/* A direct software reset keeps this initialization retryable. Unlike
	 * device_init(), a failed transaction does not poison Zephyr's device
	 * state and the next delayed attempt reaches the sensor again. */
	rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL3_C_REG,
				       EDGEZ_IMU_CTRL3_SW_RESET);
	if (rc < 0) {
		return rc;
	}
	for (uint32_t waited_ms = 0U; waited_ms < EDGEZ_IMU_RESET_TIMEOUT_MS;
	     waited_ms++) {
		k_msleep(1);
		rc = i2c_reg_read_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL3_C_REG, &ctrl3);
		if (rc < 0) {
			return rc;
		}
		if ((ctrl3 & EDGEZ_IMU_CTRL3_SW_RESET) == 0U) {
			break;
		}
		if (waited_ms + 1U == EDGEZ_IMU_RESET_TIMEOUT_MS) {
			return -ETIMEDOUT;
		}
	}

	rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL3_C_REG,
				       EDGEZ_IMU_CTRL3_BDU | EDGEZ_IMU_CTRL3_IF_INC);
	if (rc == 0) {
		/* Use the low-power paths at the 12.5 Hz output data rate. */
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL6_C_REG, BIT(4));
	}
	if (rc == 0) {
		rc = i2c_reg_write_byte_dt(&imu_i2c, EDGEZ_IMU_CTRL7_G_REG, BIT(7));
	}
	if (rc == 0) {
		rc = set_sampling_rate(EDGEZ_IMU_SAMPLE_RATE_HZ);
	}
	if (rc == 0) {
		rc = configure_fifo();
	}
	return rc;
}

#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
static void imu_sample_work_handler(struct k_work *work)
{
	struct edgez_imu_sample next_sample = {0};
	uint8_t fifo_status[4];
#if !defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
	int16_t gyro_raw[3] = {0};
#endif
	int16_t accel_raw[3] = {0};
	uint16_t available_words;
	uint16_t words_to_read;
	uint16_t fifo_pattern;
#if !defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
	uint8_t gyro_valid = 0U;
#endif
	uint8_t accel_valid = 0U;
	uint32_t quiet_remaining_ms;
	int rc;

	ARG_UNUSED(work);
	if (!imu_ready) {
		return;
	}
	quiet_remaining_ms = halow_tx_quiet_remaining_ms();
	if (quiet_remaining_ms > 0U) {
		/* A skipped collision is not an IMU failure. Try again immediately
		 * after the radio's short post-beacon quiet window. */
		(void)k_work_schedule(&imu_sample_work, K_MSEC(quiet_remaining_ms));
		return;
	}

	rc = i2c_burst_read_dt(&imu_i2c, EDGEZ_IMU_FIFO_STATUS1_REG,
			    fifo_status, sizeof(fifo_status));
	if (rc < 0) {
		goto sample_failed;
	}
	available_words = fifo_status[0] | ((uint16_t)(fifo_status[1] & 0x07U) << 8);
	fifo_pattern = fifo_status[2] | ((uint16_t)(fifo_status[3] & 0x03U) << 8);
	if (fifo_status[1] & EDGEZ_IMU_FIFO_STATUS_OVERRUN) {
		LOG_WRN("IMU FIFO overrun available_words=%u", available_words);
	}
	words_to_read = MIN(available_words, EDGEZ_IMU_FIFO_DMA_WORDS);
	if (words_to_read < EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE) {
		goto schedule_fallback;
	}

	rc = i2c_burst_read_dt(&imu_i2c, EDGEZ_IMU_FIFO_DATA_OUT_L_REG,
			    fifo_raw, words_to_read * sizeof(uint16_t));
	if (rc < 0) {
		goto sample_failed;
	}

	/* FIFO_PATTERN identifies the first 16-bit word in the transfer. */
	for (uint16_t i = 0; i < words_to_read; ++i) {
#if defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
		uint8_t pattern = (uint8_t)((fifo_pattern + i) % 3U);
		int16_t value = (int16_t)sys_get_le16(&fifo_raw[i * 2U]);

		accel_raw[pattern] = value;
		accel_valid |= BIT(pattern);
#else
		uint8_t pattern = (uint8_t)((fifo_pattern + i) % 6U);
		int16_t value = (int16_t)sys_get_le16(&fifo_raw[i * 2U]);

		if (pattern < 3U) {
			gyro_raw[pattern] = value;
			gyro_valid |= BIT(pattern);
		} else {
			accel_raw[pattern - 3U] = value;
			accel_valid |= BIT(pattern - 3U);
		}
#endif
	}
	if (accel_valid != 0x07U
#if !defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
	    || gyro_valid != 0x07U
#endif
	) {
		rc = -EIO;
		goto sample_failed;
	}
	for (size_t i = 0; i < 3; ++i) {
		next_sample.accel_m_s2[i] =
			(float)accel_raw[i] * EDGEZ_IMU_ACCEL_M_S2_PER_LSB;
#if !defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
		next_sample.gyro_rad_s[i] =
			(float)gyro_raw[i] * EDGEZ_IMU_GYRO_RAD_S_PER_LSB;
#endif
	}
#if !defined(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY)
	next_sample.gyro_valid = true;
#endif
	k_mutex_lock(&imu_lock, K_FOREVER);
	latest_sample = next_sample;
	imu_sample_valid = true;
	k_mutex_unlock(&imu_lock);
	imu_sample_failure_count = 0;
	LOG_DBG("IMU FIFO drained words=%u available=%u pattern=%u",
		words_to_read, available_words, fifo_pattern);
	if (available_words - words_to_read >= EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE) {
		(void)k_work_reschedule(&imu_sample_work, K_NO_WAIT);
		return;
	}
	goto schedule_fallback;

sample_failed:
	imu_sample_failure_count++;
	if (imu_sample_failure_count == 1 || imu_sample_failure_count % 10U == 0) {
		LOG_WRN("IMU FIFO drain failed: %d (count=%u)", rc,
			imu_sample_failure_count);
	}
	if (imu_sample_failure_count >= EDGEZ_IMU_RESTART_FAILURE_LIMIT) {
		LOG_ERR("IMU unavailable after %u consecutive FIFO read failures; restarting",
			imu_sample_failure_count);
		k_msleep(100);
		sys_reboot(SYS_REBOOT_COLD);
		CODE_UNREACHABLE;
	}

schedule_fallback:
	(void)k_work_schedule(&imu_sample_work,
			      K_MSEC(EDGEZ_IMU_FIFO_FALLBACK_MS));
}
#endif

int edgez_imu_init(void)
{
	static uint32_t init_failure_count;
	int rc;

	if (!imu_i2c.bus) {
		return -ENODEV;
	}
	if (imu_ready) {
		return 0;
	}

	rc = imu_configure();
	if (rc < 0) {
		init_failure_count++;
		if (init_failure_count == 1 || (init_failure_count % 12U) == 0U) {
			LOG_WRN("IMU initialization failed rc=%d bus=%s addr=0x%02x attempt=%u",
				rc, imu_i2c.bus->name, imu_i2c.addr,
				init_failure_count);
		}
		return rc;
	}
	imu_ready = true;
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	/* Runtime PM is deliberately not enabled for the full application image.
	 * Match the low-power reference by disabling TWIM30 and applying its sleep
	 * pinctrl state between the 15-second FIFO drains. The IMU keeps filling its
	 * hardware FIFO independently while the MCU bus peripheral is off. */
	rc = imu_i2c_set_active(false);
	if (rc != 0) {
		imu_ready = false;
		LOG_WRN("IMU I2C suspend after initialization failed rc=%d", rc);
		return rc;
	}
#endif
#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	imu_sample_failure_count = 0;
#endif
	init_failure_count = 0;
#if !defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	(void)k_work_schedule(&imu_sample_work, K_MSEC(EDGEZ_IMU_SETTLE_MS));
#endif
	LOG_INF("IMU ready bus=%s addr=0x%02x mode=%s rate=%d Hz FIFO watermark=%u samples EasyDMA batch=%u bytes",
		imu_i2c.bus->name, imu_i2c.addr,
		IS_ENABLED(CONFIG_OFFGRID_NRF54_IMU_ACCEL_ONLY) ? "accelerometer-only" : "6-axis",
		EDGEZ_IMU_SAMPLE_RATE_HZ,
		EDGEZ_IMU_FIFO_WATERMARK_SAMPLES, EDGEZ_IMU_FIFO_BUFFER_BYTES);
	return 0;
}

bool edgez_imu_is_ready(void)
{
	return imu_ready;
}

int edgez_imu_drain_fifo(void)
{
#if defined(CONFIG_OFFGRID_NRF54_IMU_TIMER_DRAIN)
	struct edgez_imu_sample next_sample = {0};
	bool captured_sample = false;
	int result;

	if (!imu_ready) {
		return -ENODEV;
	}
	result = imu_i2c_set_active(true);
	if (result != 0) {
		return result;
	}

	/* Fifteen seconds at 12.5 Hz is about 188 samples. Drain in bounded
	 * EasyDMA-sized chunks and retain the newest complete XYZ tuple. */
	for (unsigned int batch = 0U; batch < 16U; ++batch) {
		uint8_t fifo_status[4];
		int16_t accel_raw[3] = {0};
		uint8_t accel_valid = 0U;
		uint16_t available_words;
		uint16_t words_to_read;
		uint16_t fifo_pattern;
		int rc = i2c_burst_read_dt(&imu_i2c, EDGEZ_IMU_FIFO_STATUS1_REG,
					    fifo_status, sizeof(fifo_status));

		if (rc < 0) {
			result = rc;
			goto suspend_bus;
		}
		available_words = fifo_status[0] |
			((uint16_t)(fifo_status[1] & 0x07U) << 8);
		fifo_pattern = fifo_status[2] |
			((uint16_t)(fifo_status[3] & 0x03U) << 8);
		words_to_read = MIN(available_words, EDGEZ_IMU_FIFO_DMA_WORDS);
		if (words_to_read < EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE) {
			break;
		}

		rc = i2c_burst_read_dt(&imu_i2c, EDGEZ_IMU_FIFO_DATA_OUT_L_REG,
					   fifo_raw,
					   words_to_read * sizeof(uint16_t));
		if (rc < 0) {
			result = rc;
			goto suspend_bus;
		}
		for (uint16_t i = 0U; i < words_to_read; ++i) {
			uint8_t pattern = (uint8_t)((fifo_pattern + i) % 3U);
			int16_t value =
				(int16_t)sys_get_le16(&fifo_raw[i * sizeof(uint16_t)]);

			accel_raw[pattern] = value;
			accel_valid |= BIT(pattern);
		}
		if (accel_valid == 0x07U) {
			for (size_t i = 0U; i < 3U; ++i) {
				next_sample.accel_m_s2[i] =
					(float)accel_raw[i] * EDGEZ_IMU_ACCEL_M_S2_PER_LSB;
			}
			captured_sample = true;
		}
		if (available_words - words_to_read <
		    EDGEZ_IMU_FIFO_WORDS_PER_SAMPLE) {
			break;
		}
	}

	if (!captured_sample) {
		result = -EAGAIN;
		goto suspend_bus;
	}
	k_mutex_lock(&imu_lock, K_FOREVER);
	latest_sample = next_sample;
	imu_sample_valid = true;
	k_mutex_unlock(&imu_lock);
	result = 0;

suspend_bus:
	{
		int suspend_rc = imu_i2c_set_active(false);

		if (result == 0 && suspend_rc != 0) {
			result = suspend_rc;
		}
	}
	return result;
#else
	return -ENOTSUP;
#endif
}

int edgez_imu_read(struct edgez_imu_sample *sample)
{
	if (!sample) {
		return -EINVAL;
	}
	if (!imu_ready) {
		return -ENODEV;
	}

	k_mutex_lock(&imu_lock, K_FOREVER);
	if (!imu_sample_valid) {
		k_mutex_unlock(&imu_lock);
		return -EAGAIN;
	}
	*sample = latest_sample;
	k_mutex_unlock(&imu_lock);
	return 0;
}
