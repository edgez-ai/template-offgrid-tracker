/*
 * nRF54L15 + FGH200M carrier minimum-current benchmark.
 *
 * Derived from the supplied fgh200test/01_power_safe_standby reference.
 * All controlled rails are disabled before every signal connected to an
 * unpowered peripheral is disconnected to prevent GPIO back-powering.
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/poweroff.h>

#include <hal/nrf_gpio.h>
#include <soc.h>

#define PIN(port, pin) NRF_GPIO_PIN_MAP(port, pin)

#define HALOW_POWER_EN PIN(2, 0)
#define HALOW_CS       PIN(1, 7)
#define HALOW_SCK      PIN(2, 1)
#define HALOW_MISO     PIN(2, 4)
#define HALOW_MOSI     PIN(2, 2)
#define HALOW_IRQ      PIN(1, 6)
#define HALOW_BUSY     PIN(1, 10)
#define HALOW_WAKE     PIN(1, 5)
#define HALOW_RESET_N  PIN(1, 4)

#define GPS_POWER_EN   PIN(1, 9)
#define GPS_RX         PIN(1, 11)
#define GPS_TX         PIN(1, 12)

#define VBAT_DIV_EN    PIN(1, 14)
#define VBAT_ADC       PIN(1, 13)
#define XIAO_VBAT_EN   PIN(1, 15)

#define IMU_POWER_EN   PIN(0, 1)
#define IMU_INT1       PIN(0, 2)
#define IMU_SCL        PIN(0, 3)
#define IMU_SDA        PIN(0, 4)

#define USER_LED       PIN(2, 5)
#define USER_KEY       PIN(1, 8)

static void rail_off(uint32_t pin)
{
	nrf_gpio_cfg_output(pin);
	nrf_gpio_pin_clear(pin);
}

static void isolate_all_peripherals(void)
{
	/* Disable controlled rails first. */
	rail_off(HALOW_POWER_EN);
	rail_off(GPS_POWER_EN);
	rail_off(VBAT_DIV_EN);
	rail_off(XIAO_VBAT_EN);
	rail_off(IMU_POWER_EN);

	/* FGH200M/MM8108 signals. */
	nrf_gpio_cfg_default(HALOW_CS);
	nrf_gpio_cfg_default(HALOW_SCK);
	nrf_gpio_cfg_default(HALOW_MISO);
	nrf_gpio_cfg_default(HALOW_MOSI);
	nrf_gpio_cfg_default(HALOW_IRQ);
	nrf_gpio_cfg_default(HALOW_BUSY);
	nrf_gpio_cfg_default(HALOW_WAKE);
	nrf_gpio_cfg_default(HALOW_RESET_N);

	/* L76K, battery divider, and LSM6DS3TR-C signals. */
	nrf_gpio_cfg_default(GPS_RX);
	nrf_gpio_cfg_default(GPS_TX);
	nrf_gpio_cfg_default(VBAT_ADC);
	nrf_gpio_cfg_default(IMU_INT1);
	nrf_gpio_cfg_default(IMU_SCL);
	nrf_gpio_cfg_default(IMU_SDA);
}

int main(void)
{
	isolate_all_peripherals();

	/* Keep the active-low LED off. P1.08 remains the only wake source. */
	nrf_gpio_cfg_output(USER_LED);
	nrf_gpio_pin_set(USER_LED);
	nrf_gpio_cfg_input(USER_KEY, NRF_GPIO_PIN_PULLUP);
	nrf_gpio_cfg_sense_set(USER_KEY, NRF_GPIO_PIN_SENSE_LOW);

	/* System ON is useful for separating application/driver current from board
	 * leakage while using the same WFI state as the functional sensor image. */
#if defined(CONFIG_OFFGRID_NRF54_ALL_OFF_SYSTEM_ON)
	/* Match the functional sensor image's explicit transition out of
	 * constant-latency mode before measuring the System ON sleep floor. */
	NRF_POWER->TASKS_LOWPWR = 1U;
	__DSB();
	__ISB();
	while (true) {
		k_sleep(K_FOREVER);
	}
#else
	/* System OFF retains the GPIO configuration and wakes by reset on KEY. */
	sys_poweroff();
#endif
	return 0;
}
