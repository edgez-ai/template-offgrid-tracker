"""Compile the actual HAL and preserve application IRQs across radio restart."""
from pathlib import Path
import subprocess
import tempfile
import unittest


STUBS = r'''
#ifndef HAL_STUBS_H
#define HAL_STUBS_H
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
typedef int gpio_num_t;
typedef int esp_err_t;
typedef struct { uint64_t pin_bit_mask; int mode, pull_up_en, pull_down_en, intr_type; } gpio_config_t;
#define CONFIG_MM_RESET_N 8
#define CONFIG_MM_SPI_IRQ 6
#define CONFIG_MM_BUSY 40
#define GPIO_NUM_0 0
#define GPIO_NUM_MAX 48
#define GPIO_IS_VALID_GPIO(p) ((p) >= 0 && (p) < GPIO_NUM_MAX)
#define GPIO_MODE_OUTPUT 1
#define GPIO_MODE_INPUT 0
#define GPIO_PULLUP_DISABLE 0
#define GPIO_PULLDOWN_DISABLE 0
#define GPIO_INTR_DISABLE 0
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 1
#define ESP_ERROR_CHECK(expr) assert((expr) == ESP_OK)
#define pdMS_TO_TICKS(ms) (ms)
#define GPIO_STATUS_W1TC_REG 1
#define GPIO_STATUS1_W1TC_REG 2
#define REG_WRITE(reg, value) fake_reg_write((reg), (value))
void gpio_hold_dis(gpio_num_t pin);
void gpio_deep_sleep_hold_dis(void);
void vTaskDelay(int ticks);
int gpio_config(const gpio_config_t *config);
int gpio_set_level(gpio_num_t pin, int level);
int gpio_intr_disable(gpio_num_t pin);
int gpio_install_isr_service(int flags);
void fake_reg_write(int reg, uint32_t value);
void esp_restart(void);
void mmhal_init(void);
#endif
'''

HARNESS = r'''
#include "hal_stubs.h"
#include <stdlib.h>
static bool enabled[GPIO_NUM_MAX];
static uint64_t pending;
static unsigned installs;
void gpio_hold_dis(gpio_num_t pin) { (void)pin; }
void gpio_deep_sleep_hold_dis(void) {}
void vTaskDelay(int ticks) { (void)ticks; }
int gpio_config(const gpio_config_t *config) {
    for (int pin = 0; pin < GPIO_NUM_MAX; ++pin)
        if (config->pin_bit_mask & (UINT64_C(1) << pin)) enabled[pin] = false;
    return ESP_OK;
}
int gpio_set_level(gpio_num_t pin, int level) { (void)pin; (void)level; return ESP_OK; }
int gpio_intr_disable(gpio_num_t pin) { enabled[pin] = false; return ESP_OK; }
int gpio_install_isr_service(int flags) {
    (void)flags;
    /* Stale level IRQs must be cleared before the first global ISR install. */
    for (int pin = 0; pin < GPIO_NUM_MAX; ++pin) assert(!enabled[pin]);
    assert(pending == 0);
    ++installs;
    return ESP_OK;
}
void fake_reg_write(int reg, uint32_t value) {
    assert(reg == GPIO_STATUS_W1TC_REG || reg == GPIO_STATUS1_W1TC_REG);
    pending &= ~((uint64_t)value << (reg == GPIO_STATUS1_W1TC_REG ? 32 : 0));
}
void esp_restart(void) { abort(); }
int main(void) {
    for (int pin = 0; pin < GPIO_NUM_MAX; ++pin) enabled[pin] = true;
    pending = UINT64_MAX;
    mmhal_init();
    assert(installs == 1);
    const uint64_t application = UINT64_C(1) | (UINT64_C(1) << 33);
    const uint64_t radio = (UINT64_C(1) << CONFIG_MM_SPI_IRQ) | (UINT64_C(1) << CONFIG_MM_BUSY);
    for (int restart = 0; restart < 2; ++restart) {
        enabled[0] = enabled[33] = enabled[CONFIG_MM_SPI_IRQ] = enabled[CONFIG_MM_BUSY] = true;
        pending = application | radio;
        mmhal_init();
        assert(enabled[0] && enabled[33]);
        assert(!enabled[CONFIG_MM_SPI_IRQ] && !enabled[CONFIG_MM_BUSY]);
        assert(pending == application);
        assert(installs == 1);
    }
    return 0;
}
'''


def check_source(source):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / 'hal_stubs.h').write_text(STUBS)
        for name in ['mmhal_os.h', 'mmosal.h', 'driver/gpio.h', 'esp_system.h',
                     'freertos/FreeRTOS.h', 'freertos/task.h', 'sdkconfig.h', 'soc/gpio_reg.h']:
            header = root / name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text('#include "hal_stubs.h"\n')
        (root / 'test.c').write_text(HARNESS)
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(root),
                        str(source), str(root / 'test.c'), '-o', str(root / 'test')], check=True)
        return subprocess.run([str(root / 'test')], capture_output=True, text=True)


class RadioRestartTests(unittest.TestCase):
    def test_cold_start_clears_stale_irqs_but_restarts_preserve_user_irqs(self):
        source = Path(__file__).resolve().parents[2] / 'main/mmhal_os_ps_override.c'
        result = check_source(source)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
