#include "factory_reset_button.h"

#include <stdbool.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

static const char *TAG = "factory_reset";

#define FACTORY_RESET_MAGIC 0xa5f0c1e5U

static RTC_NOINIT_ATTR uint32_t s_factory_reset_magic;
static RTC_NOINIT_ATTR uint32_t s_factory_reset_magic_inv;

static bool button_is_pressed(void)
{
    const int level = gpio_get_level((gpio_num_t)CONFIG_DAB_FACTORY_RESET_BUTTON_GPIO);
#if CONFIG_DAB_FACTORY_RESET_BUTTON_ACTIVE_LOW
    return level == 0;
#else
    return level != 0;
#endif
}

static void factory_reset_button_task(void *arg)
{
    (void)arg;
    const TickType_t poll_ticks = pdMS_TO_TICKS(CONFIG_DAB_FACTORY_RESET_BUTTON_POLL_MS);
    const TickType_t hold_ticks = pdMS_TO_TICKS(CONFIG_DAB_FACTORY_RESET_BUTTON_HOLD_MS);
    TickType_t pressed_since = 0;

    while (true) {
        if (button_is_pressed()) {
            if (pressed_since == 0) {
                pressed_since = xTaskGetTickCount();
                ESP_LOGI(TAG, "Button pressed; hold for %d ms to erase NVS",
                         CONFIG_DAB_FACTORY_RESET_BUTTON_HOLD_MS);
            } else if ((xTaskGetTickCount() - pressed_since) >= hold_ticks) {
                /* GPIO35 is a boot strap on the Waveshare board. Waiting for
                 * release also prevents immediately triggering again. */
                ESP_LOGW(TAG, "Factory reset armed; release button to continue");
                while (button_is_pressed()) {
                    vTaskDelay(poll_ticks);
                }
                vTaskDelay(pdMS_TO_TICKS(100));

                s_factory_reset_magic = FACTORY_RESET_MAGIC;
                s_factory_reset_magic_inv = ~FACTORY_RESET_MAGIC;
                ESP_LOGW(TAG, "Button released; restarting to erase NVS");
                esp_restart();
            }
        } else if (pressed_since != 0) {
            ESP_LOGI(TAG, "Factory reset cancelled");
            pressed_since = 0;
        }
        vTaskDelay(poll_ticks);
    }
}

esp_err_t factory_reset_button_handle_pending(void)
{
    const bool requested =
        s_factory_reset_magic == FACTORY_RESET_MAGIC &&
        s_factory_reset_magic_inv == (uint32_t)~FACTORY_RESET_MAGIC &&
        esp_reset_reason() == ESP_RST_SW;

    s_factory_reset_magic = 0;
    s_factory_reset_magic_inv = 0;
    if (!requested) {
        return ESP_OK;
    }

    ESP_LOGW(TAG, "Factory reset requested; erasing default NVS partition");
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK && err != ESP_ERR_NVS_NO_FREE_PAGES &&
        err != ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS initialization before erase returned %s",
                 esp_err_to_name(err));
    }
    err = nvs_flash_erase();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS erase failed: %s", esp_err_to_name(err));
        return err;
    }
    err = nvs_flash_init();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Factory reset complete; provisioning data cleared");
    }
    return err;
}

esp_err_t factory_reset_button_start(void)
{
    const gpio_num_t gpio = (gpio_num_t)CONFIG_DAB_FACTORY_RESET_BUTTON_GPIO;
    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
#if CONFIG_DAB_FACTORY_RESET_BUTTON_ACTIVE_LOW
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
#else
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
#endif
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        return err;
    }

    if (xTaskCreate(factory_reset_button_task, "factory_reset",
                    CONFIG_DAB_FACTORY_RESET_BUTTON_TASK_STACK_SIZE, NULL,
                    CONFIG_DAB_FACTORY_RESET_BUTTON_TASK_PRIORITY, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "Long-press NVS reset enabled on GPIO%d (%s, hold %d ms)",
             CONFIG_DAB_FACTORY_RESET_BUTTON_GPIO,
#if CONFIG_DAB_FACTORY_RESET_BUTTON_ACTIVE_LOW
             "active low",
#else
             "active high",
#endif
             CONFIG_DAB_FACTORY_RESET_BUTTON_HOLD_MS);
    return ESP_OK;
}
