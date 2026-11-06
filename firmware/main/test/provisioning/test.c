#include <assert.h>
#include <inttypes.h>
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include "cJSON.h"
#include "halow_provisioning.h"

#define CONFIG_DAB_DIRECT_MQTT 1
#define NETWORK_PROV_EVENT 1
#define NETWORK_PROV_START 2
#define NETWORK_PROV_END 3
#define NETWORK_PROV_WIFI_CRED_SUCCESS 4
#define NETWORK_PROV_WIFI_CRED_FAIL 5
#define NETWORK_PROV_SECURITY_1 1
#define ESP_EVENT_ANY_ID -1
#define ESP_MAC_WIFI_STA 1
#define NETWORK_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM 0
#define NVS_READWRITE 1
#define NVS_READONLY 0
#define pdPASS 1
#define pdMS_TO_TICKS(ms) (ms)
typedef int esp_event_base_t;
typedef int nvs_handle_t;
typedef struct { int scheme; int scheme_event_handler; } network_prov_mgr_config_t;
static const int network_prov_scheme_ble = 1;
static unsigned stop_tasks, restart_tasks, stops, resets;
static bool fail_commit;
static void log_message(const char *tag, const char *format, ...) { (void)tag; (void)format; }
#define ESP_LOGI(...) log_message(__VA_ARGS__)
#define ESP_LOGW(...) log_message(__VA_ARGS__)
static const char *esp_err_to_name(int err) { return err ? "failed" : "ok"; }
static void vTaskDelay(int ticks) { (void)ticks; }
static void vTaskDelete(void *task) { (void)task; }
static void esp_restart(void) { ++restart_tasks; }
static int xTaskCreate(void (*fn)(void *), const char *name, int stack, void *arg, int priority, void *handle)
{
    (void)fn; (void)stack; (void)arg; (void)priority; (void)handle;
    if (strcmp(name, "prov_stop") == 0) ++stop_tasks;
    else ++restart_tasks;
    return pdPASS;
}
static void network_prov_mgr_stop_provisioning(void) { ++stops; }
static void network_prov_mgr_deinit(void) {}
static int network_prov_mgr_reset_wifi_sm_state_on_failure(void) { ++resets; return ESP_OK; }
static int network_prov_mgr_init(network_prov_mgr_config_t config) { (void)config; return ESP_OK; }
static int network_prov_mgr_endpoint_create(const char *name) { (void)name; return ESP_OK; }
static int network_prov_scheme_ble_set_service_uuid(uint8_t *uuid) { (void)uuid; return ESP_OK; }
static int network_prov_mgr_start_provisioning(int security, const char *pop, const char *name, void *key)
{ (void)security; (void)pop; (void)name; (void)key; return ESP_OK; }
typedef void (*event_handler_t)(void *, esp_event_base_t, int32_t, void *);
static int esp_event_handler_register(int base, int event, event_handler_t fn, void *arg)
{ (void)base; (void)event; (void)fn; (void)arg; return ESP_OK; }
static int esp_event_handler_unregister(int base, int event, event_handler_t fn)
{ (void)base; (void)event; (void)fn; return ESP_OK; }
typedef esp_err_t (*endpoint_t)(uint32_t, const uint8_t *, ssize_t, uint8_t **, ssize_t *, void *);
static int network_prov_mgr_endpoint_register(const char *name, endpoint_t fn, void *arg)
{ (void)name; (void)fn; (void)arg; return ESP_OK; }
static int esp_read_mac(uint8_t *mac, int type) { (void)type; memset(mac, 1, 6); return ESP_OK; }
static int nvs_flash_init(void) { return ESP_OK; }
static int nvs_flash_erase(void) { return ESP_OK; }
static int nvs_open(const char *name, int mode, int *handle)
{ (void)name; (void)mode; *handle = 1; return ESP_OK; }
static void nvs_close(int handle) { (void)handle; }
static int nvs_commit(int handle) { (void)handle; return fail_commit ? ESP_ERR_NO_MEM : ESP_OK; }
static struct { char key[16]; uint8_t value[512]; size_t length; } entries[24];
static unsigned entry_count;
static int nvs_set_blob(int handle, const char *key, const void *value, size_t size)
{
    (void)handle;
    unsigned i;
    for (i = 0; i < entry_count && strcmp(entries[i].key, key); ++i) {}
    if (i == entry_count) { assert(entry_count < 24); ++entry_count; }
    assert(strlen(key) < sizeof(entries[i].key) && size <= sizeof(entries[i].value));
    strcpy(entries[i].key, key); memcpy(entries[i].value, value, size); entries[i].length = size;
    return ESP_OK;
}
static int nvs_get_blob(int handle, const char *key, void *value, size_t *size)
{
    (void)handle;
    for (unsigned i = 0; i < entry_count; ++i) {
        if (strcmp(entries[i].key, key)) continue;
        if (*size < entries[i].length) return ESP_ERR_NO_MEM;
        *size = entries[i].length; memcpy(value, entries[i].value, *size); return ESP_OK;
    }
    return ESP_ERR_NVS_NOT_FOUND;
}
static int nvs_set_str(int h, const char *k, const char *v) { return nvs_set_blob(h, k, v, strlen(v) + 1); }
static int nvs_get_str(int h, const char *k, char *v, size_t *s) { return nvs_get_blob(h, k, v, s); }
static int nvs_set_u8(int h, const char *k, uint8_t v) { return nvs_set_blob(h, k, &v, 1); }
static int nvs_get_u8(int h, const char *k, uint8_t *v) { size_t s = 1; return nvs_get_blob(h, k, v, &s); }
static int nvs_erase_key(int h, const char *key)
{
    (void)h;
    for (unsigned i = 0; i < entry_count; ++i) {
        if (!strcmp(entries[i].key, key)) { entries[i] = entries[--entry_count]; return ESP_OK; }
    }
    return ESP_ERR_NVS_NOT_FOUND;
}
static bool edgez_rf_resolve_s1g_channel(const char *country, uint8_t channel, uint32_t *frequency, uint8_t *bandwidth)
{ (void)country; *frequency = 915000; *bandwidth = 2; return channel == 7; }
#include "provisioning.inc"

static const char *mesh_json = "{\"clientId\":\"33c84b34-4599-4ed9-894f-b5f48df6fd8c\",\"meshId\":\"mesh\",\"passphrase\":\"\",\"country\":\"US\",\"halowChannel\":7}";
static const char *wifi_json = "{\"clientId\":\"33c84b34-4599-4ed9-894f-b5f48df6fd8c\",\"meshId\":\"mesh\",\"passphrase\":\"password\",\"country\":\"US\",\"halowChannel\":7,\"wifiUpstream\":true,\"username\":\"AABBCCDDEEFF\",\"password\":\"mqtt-secret\",\"projectId\":\"project-a\"}";
static esp_err_t configure(const char *json)
{
    uint8_t *response = NULL; ssize_t length = 0;
    const int result = config_endpoint(0, (const uint8_t *)json, strlen(json), &response, &length, NULL);
    assert(response && length > 0); free(response); return result;
}
int main(void)
{
    halow_provisioning_config_t loaded;
    bool provisioned;
    assert(configure(mesh_json) == ESP_OK);
    assert(stop_tasks == 1 && restart_after_stop);
    assert(halow_provisioning_init(&loaded, &provisioned) == ESP_OK && provisioned);
    assert(!loaded.wifi_upstream && !loaded.passphrase[0]);
    /* Old mesh profiles with no new Wi-Fi keys remain valid. */
    nvs_erase_key(1, "wifiUpstream"); nvs_erase_key(1, "wifiPending");
    assert(halow_provisioning_init(&loaded, &provisioned) == ESP_OK && provisioned);
    assert(configure(wifi_json) == ESP_OK);
    assert(stop_tasks == 1 && !restart_after_stop && wifi_required);
    assert(halow_provisioning_init(&loaded, &provisioned) == ESP_OK && !provisioned);
    provisioning_event(NULL, NETWORK_PROV_EVENT, NETWORK_PROV_WIFI_CRED_FAIL, NULL);
    assert(!restart_after_stop);
    assert(halow_provisioning_init(&loaded, &provisioned) == ESP_OK && !provisioned);
    assert(configure(wifi_json) == ESP_OK); /* retry after failure */
    provisioning_event(NULL, NETWORK_PROV_EVENT, NETWORK_PROV_WIFI_CRED_SUCCESS, NULL);
    assert(restart_after_stop && stop_tasks == 1); /* phone can still query status */
    assert(halow_provisioning_init(&loaded, &provisioned) == ESP_OK && provisioned);
    assert(loaded.wifi_upstream && !strcmp(loaded.mqtt_username, "AABBCCDDEEFF"));
    assert(!strcmp(loaded.mqtt_password, "mqtt-secret") && !strcmp(loaded.project_id, "project-a"));
    provisioning_event(NULL, NETWORK_PROV_EVENT, NETWORK_PROV_END, NULL);
    assert(restart_tasks == 1);
    assert(configure(wifi_json) == ESP_OK);
    fail_commit = true;
    provisioning_event(NULL, NETWORK_PROV_EVENT, NETWORK_PROV_WIFI_CRED_SUCCESS, NULL);
    assert(!restart_after_stop); /* a failed NVS commit must never reboot as configured */
    fail_commit = false;
    cJSON *invalid = cJSON_Parse(wifi_json);
    cJSON_DeleteItemFromObject(invalid, "password");
    char *json = cJSON_PrintUnformatted(invalid);
    assert(configure(json) != ESP_OK);
    free(json); cJSON_Delete(invalid);
    puts("Provisioning lifecycle checks passed");
    return 0;
}
