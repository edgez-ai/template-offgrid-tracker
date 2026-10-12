/*
 * HT-HC33/MM6108 power-save experiment.
 *
 * MM_BUSY duty is an activity proxy, not a current measurement. Measure the
 * board supply current during the log-marked baseline and power-save windows.
 */

#include "mesh_ps_test.h"

#include <inttypes.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "mmhal_wlan.h"
#include "mmwlan.h"

/*
 * The source-built mesh runtime owns the UMAC and does not expose the public
 * mmwlan power-save API. These are the lower-driver operations used by that
 * API. The test profile creates exactly one radio interface; its VIF ID is
 * configurable and must match the "Private EdgeZ UMAC started ... vif=N" log.
 */
extern enum mmwlan_status mmdrv_set_wake_enabled(bool enabled);
extern enum mmwlan_status mmdrv_set_chip_power_save_enabled(uint16_t vif_id,
                                                             bool enabled);
extern enum mmwlan_status mmdrv_set_dynamic_ps_timeout(uint32_t timeout_ms);

/* Kconfig may omit an integer symbol whose selected value is zero. */
#ifndef CONFIG_OFFGRID_MESH_PS_VIF_ID
#define CONFIG_OFFGRID_MESH_PS_VIF_ID 0
#endif

#define LINK_CONNECTED_BIT BIT0

static const char *TAG = "mesh_ps_test";
static EventGroupHandle_t link_events;
static TaskHandle_t test_task;
static volatile bool link_connected;

typedef struct {
    uint32_t busy_samples;
    uint32_t total_samples;
    bool link_retained;
} phase_result_t;

void mesh_ps_test_notify_link(bool connected)
{
    link_connected = connected;
    if (link_events == NULL) {
        return;
    }

    if (connected) {
        xEventGroupSetBits(link_events, LINK_CONNECTED_BIT);
    } else {
        xEventGroupClearBits(link_events, LINK_CONNECTED_BIT);
    }
}

static bool is_link_connected(void)
{
    return (xEventGroupGetBits(link_events) & LINK_CONNECTED_BIT) != 0;
}

static bool wait_with_link(uint32_t duration_ms)
{
    const TickType_t interval = pdMS_TO_TICKS(10);
    const TickType_t duration = pdMS_TO_TICKS(duration_ms);
    const TickType_t started = xTaskGetTickCount();

    while ((xTaskGetTickCount() - started) < duration) {
        if (!is_link_connected()) {
            return false;
        }
        vTaskDelay(interval > 0 ? interval : 1);
    }
    return true;
}

static phase_result_t sample_phase(uint32_t duration_s)
{
    phase_result_t result = {
        .link_retained = true,
    };
    const TickType_t interval =
        pdMS_TO_TICKS(CONFIG_OFFGRID_MESH_PS_SAMPLE_INTERVAL_MS);
    const TickType_t duration = pdMS_TO_TICKS(duration_s * 1000U);
    const TickType_t started = xTaskGetTickCount();

    while ((xTaskGetTickCount() - started) < duration) {
        if (!is_link_connected()) {
            result.link_retained = false;
            break;
        }
        if (mmhal_wlan_busy_is_asserted()) {
            ++result.busy_samples;
        }
        ++result.total_samples;
        vTaskDelay(interval > 0 ? interval : 1);
    }
    return result;
}

static unsigned busy_percent_x10(const phase_result_t *result)
{
    if (result->total_samples == 0) {
        return 0;
    }
    return (unsigned)(((uint64_t)result->busy_samples * 1000U) /
                      result->total_samples);
}

static void log_result(const char *phase, const phase_result_t *result)
{
    const unsigned percent_x10 = busy_percent_x10(result);
    ESP_LOGI(TAG,
             "%s: MM_BUSY asserted %" PRIu32 "/%" PRIu32
             " samples (%u.%u%% duty), link=%s",
             phase, result->busy_samples, result->total_samples,
             percent_x10 / 10U, percent_x10 % 10U,
             result->link_retained ? "up" : "lost");
}

static bool set_ps_enabled(bool enabled)
{
    enum mmwlan_status status;

    if (!enabled) {
        /* Hold MM_WAKE first, then tell the chip to leave power-save mode. */
        status = mmdrv_set_wake_enabled(true);
        if (status == MMWLAN_SUCCESS) {
            status = mmdrv_set_chip_power_save_enabled(
                CONFIG_OFFGRID_MESH_PS_VIF_ID, false);
        }
    } else {
        /* Match the reference UMAC ordering: release wake, then enable PS. */
        status = mmdrv_set_wake_enabled(false);
        if (status == MMWLAN_SUCCESS) {
            status = mmdrv_set_chip_power_save_enabled(
                CONFIG_OFFGRID_MESH_PS_VIF_ID, true);
            if (status != MMWLAN_SUCCESS) {
                /* Do not leave MM_WAKE released after a rejected PS command. */
                (void)mmdrv_set_wake_enabled(true);
            }
        }
    }

    if (status != MMWLAN_SUCCESS) {
        ESP_LOGE(TAG, "Could not %s power save on mesh VIF %d: status=%d",
                 enabled ? "enable" : "disable",
                 CONFIG_OFFGRID_MESH_PS_VIF_ID, (int)status);
        return false;
    }
    return true;
}

static void mesh_ps_test_task(void *arg)
{
    (void)arg;
    ESP_LOGW(TAG, "Waiting for an established 802.11s peer before testing PS");
    ESP_LOGW(TAG, "Use a current meter; MM_BUSY duty is only an activity proxy");

    for (;;) {
        xEventGroupWaitBits(link_events, LINK_CONNECTED_BIT,
                            pdFALSE, pdTRUE, portMAX_DELAY);
        ESP_LOGI(TAG, "Peer established; starting power-save A/B cycle");

        if (!set_ps_enabled(false)) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (!wait_with_link(CONFIG_OFFGRID_MESH_PS_SETTLE_MS)) {
            ESP_LOGW(TAG, "Peer lost before the baseline; waiting to re-peer");
            continue;
        }

        ESP_LOGI(TAG, "BASELINE START: PS disabled for %d seconds",
                 CONFIG_OFFGRID_MESH_PS_BASELINE_SECONDS);
        const phase_result_t baseline =
            sample_phase(CONFIG_OFFGRID_MESH_PS_BASELINE_SECONDS);
        log_result("BASELINE END", &baseline);
        if (!baseline.link_retained) {
            ESP_LOGW(TAG, "Baseline invalid because the peer was lost");
            continue;
        }

        const enum mmwlan_status timeout_status =
            mmdrv_set_dynamic_ps_timeout(
                CONFIG_OFFGRID_MESH_PS_DYNAMIC_TIMEOUT_MS);
        if (timeout_status != MMWLAN_SUCCESS) {
            ESP_LOGE(TAG, "Could not set dynamic PS timeout: status=%d",
                     (int)timeout_status);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (!set_ps_enabled(true)) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (!wait_with_link(CONFIG_OFFGRID_MESH_PS_SETTLE_MS)) {
            ESP_LOGE(TAG, "Peer was lost immediately after enabling PS");
            (void)set_ps_enabled(false);
            continue;
        }

        ESP_LOGI(TAG,
                 "POWER SAVE ENABLED: timeout=%d ms; reporting every %d seconds",
                 CONFIG_OFFGRID_MESH_PS_DYNAMIC_TIMEOUT_MS,
                 CONFIG_OFFGRID_MESH_PS_REPORT_SECONDS);

        while (is_link_connected()) {
            const phase_result_t power_save =
                sample_phase(CONFIG_OFFGRID_MESH_PS_REPORT_SECONDS);
            log_result("POWER SAVE", &power_save);
            if (!power_save.link_retained) {
                break;
            }

            const int change_x10 =
                (int)busy_percent_x10(&power_save) -
                (int)busy_percent_x10(&baseline);
            const unsigned magnitude =
                (unsigned)(change_x10 < 0 ? -change_x10 : change_x10);
            ESP_LOGI(TAG,
                     "BUSY duty change from baseline: %c%u.%u percentage points",
                     change_x10 < 0 ? '-' : '+',
                     magnitude / 10U, magnitude % 10U);
        }

        ESP_LOGE(TAG, "Peer lost during PS; disabling PS and waiting to re-peer");
        (void)set_ps_enabled(false);
    }
}

esp_err_t mesh_ps_test_start(void)
{
    if (test_task != NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    link_events = xEventGroupCreate();
    if (link_events == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (link_connected) {
        xEventGroupSetBits(link_events, LINK_CONNECTED_BIT);
    }

    const UBaseType_t priority =
        CONFIG_HALOW_INIT_TASK_PRIORITY > 1
            ? CONFIG_HALOW_INIT_TASK_PRIORITY - 1
            : 1;
    const BaseType_t created = xTaskCreate(mesh_ps_test_task,
                                           "mesh_ps_test",
                                           4096,
                                           NULL,
                                           priority,
                                           &test_task);
    if (created != pdPASS) {
        vEventGroupDelete(link_events);
        link_events = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
