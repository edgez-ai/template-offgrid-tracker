#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_app_desc.h"
#include "esp_mac.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_hs_id.h"
#include "nimble/ble.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "pb_decode.h"
#include "pb_encode.h"
#include "usb_control.pb.h"

#define EDGEZ_CONTROL_SERVICE_UUID 0xfff0
#define EDGEZ_CONTROL_RX_UUID 0xfff1
#define EDGEZ_CONTROL_TX_UUID 0xfff2
#define EDGEZ_FRAME_HEADER_SIZE 4U
#define EDGEZ_MAX_PACKET_SIZE 512U
#define EDGEZ_RX_BUFFER_SIZE (EDGEZ_MAX_PACKET_SIZE * 2U)
#define EDGEZ_STATUS_INTERVAL_MS 5000U
#define EDGEZ_INVALID_CONNECTION_HANDLE BLE_HS_CONN_HANDLE_NONE

static const char *TAG = "edgez_ble";
static uint8_t own_address_type;
static bool started;
static uint16_t tx_value_handle;
static uint16_t connection_handle = EDGEZ_INVALID_CONNECTION_HANDLE;
static bool notifications_enabled;
static uint8_t rx_buffer[EDGEZ_RX_BUFFER_SIZE];
static size_t rx_length;
static SemaphoreHandle_t state_lock;
static SemaphoreHandle_t mesh_init_signal;
static TaskHandle_t status_task_handle;
static uint8_t settings_reports_remaining;

typedef struct {
    char country_code[3];
    char mesh_id[33];
    char passphrase[65];
    uint32_t frequency_khz;
    uint8_t bandwidth_mhz;
    uint64_t user_id_high;
    uint64_t user_id_low;
    char user_name[65];
    uint8_t user_public_key[32];
    size_t user_public_key_len;
    ai_edgez_halow_MarkerColor marker;
    bool share_location;
    float latitude;
    float longitude;
    uint32_t max_hop;
    uint32_t beacon_interval_seconds;
    uint8_t mac[6];
    bool stack_initialized;
    bool link_up;
    bool route_ready;
} edgez_control_state_t;

static edgez_control_state_t control_state = {
    .marker = ai_edgez_halow_MarkerColor_MARKER_BLUE,
    .max_hop = 4,
    .beacon_interval_seconds = 30,
};

/* Keep the control link responsive enough for messages while allowing the
 * peripheral to skip most connection events when no data is pending. The
 * Android central may clamp these values, so log the negotiated result. */
static const struct ble_gap_upd_params low_power_connection = {
    .itvl_min = 80,           /* 100 ms */
    .itvl_max = 96,           /* 120 ms */
    .latency = 4,             /* up to ~600 ms between attended events */
    .supervision_timeout = 600, /* 6 seconds */
    .min_ce_len = 0,
    .max_ce_len = 0,
};

static uint64_t mac_to_u64(const uint8_t mac[6])
{
    uint64_t value = 0;
    for (size_t i = 0; i < 6; ++i) {
        value = (value << 8) | mac[i];
    }
    return value;
}

static ai_edgez_halow_MarkerColor marker_from_name(const char *name)
{
    static const char *const names[] = {
        "default", "red", "blue", "purple", "yellow", "pink", "brown",
        "green", "orange", "deep_purple", "light_blue", "cyan", "teal",
        "lime", "deep_orange", "gray", "blue_gray",
    };
    if (name != NULL) {
        for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
            if (strcmp(name, names[i]) == 0) {
                return (ai_edgez_halow_MarkerColor)i;
            }
        }
    }
    return ai_edgez_halow_MarkerColor_MARKER_BLUE;
}

static void response_base(const ai_edgez_halow_NetworkPacket *request,
                          ai_edgez_halow_NetworkPacket *response)
{
    response->from = request == NULL ? 0 : request->to;
    response->to = request == NULL ? 0 : request->from;
    response->operation = ai_edgez_halow_Operation_RESPONSE;
    response->interface = ai_edgez_halow_Interface_HALOW;
}

static void fill_status(ai_edgez_halow_HaLowInterfaceStatus *status)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    status->supported = true;
    status->stack_initialized = control_state.stack_initialized;
    status->mesh_mode = true;
    status->link_up = control_state.link_up;
    status->route_ready = control_state.route_ready;
    status->ready_for_report = control_state.route_ready;
    status->ethertype = 0x88B5;
    strlcpy(status->mesh_id, control_state.mesh_id, sizeof(status->mesh_id));
    status->mac_address = mac_to_u64(control_state.mac);
    status->license_status =
        ai_edgez_halow_LicenseStatus_LICENSE_STATUS_AUTHORIZED;
    strlcpy(status->firmware_version, esp_app_get_description()->version,
            sizeof(status->firmware_version));
    xSemaphoreGive(state_lock);
}

static void fill_device_settings(ai_edgez_halow_DeviceSettings *settings)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    settings->action =
        ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
    settings->device_mode_enabled = true;
    strlcpy(settings->mesh_id, control_state.mesh_id,
            sizeof(settings->mesh_id));
    settings->share_location = control_state.share_location;
    strlcpy(settings->user_name, control_state.user_name,
            sizeof(settings->user_name));
    settings->marker = control_state.marker;
    settings->beacon_interval_seconds = control_state.beacon_interval_seconds;
    settings->user_id_high = control_state.user_id_high;
    settings->user_id_low = control_state.user_id_low;
    settings->user_public_key.size = control_state.user_public_key_len;
    memcpy(settings->user_public_key.bytes, control_state.user_public_key,
           control_state.user_public_key_len);
    settings->latitude = control_state.latitude;
    settings->longitude = control_state.longitude;
    settings->max_hop = control_state.max_hop;
    strlcpy(settings->passphrase, control_state.passphrase,
            sizeof(settings->passphrase));
    settings->device_type = ai_edgez_halow_DeviceType_DEVICE_TYPE_RELAY;
    settings->mesh_frequency_khz = control_state.frequency_khz;
    settings->mesh_bandwidth_mhz = control_state.bandwidth_mhz;
    xSemaphoreGive(state_lock);
}

static esp_err_t notify_packet(const ai_edgez_halow_NetworkPacket *packet)
{
    uint8_t payload[EDGEZ_MAX_PACKET_SIZE];
    uint8_t frame[EDGEZ_FRAME_HEADER_SIZE + EDGEZ_MAX_PACKET_SIZE];
    pb_ostream_t stream = pb_ostream_from_buffer(payload, sizeof(payload));
    if (!pb_encode(&stream, ai_edgez_halow_NetworkPacket_fields, packet)) {
        ESP_LOGE(TAG, "NetworkPacket encode failed: %s", PB_GET_ERROR(&stream));
        return ESP_ERR_INVALID_SIZE;
    }

    uint16_t active_connection;
    bool can_notify;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    active_connection = connection_handle;
    can_notify = notifications_enabled;
    xSemaphoreGive(state_lock);
    if (!can_notify || active_connection == EDGEZ_INVALID_CONNECTION_HANDLE) {
        return ESP_ERR_INVALID_STATE;
    }

    frame[0] = 'E';
    frame[1] = 'Z';
    frame[2] = (uint8_t)(stream.bytes_written & 0xffU);
    frame[3] = (uint8_t)(stream.bytes_written >> 8);
    memcpy(&frame[EDGEZ_FRAME_HEADER_SIZE], payload, stream.bytes_written);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(
        frame, EDGEZ_FRAME_HEADER_SIZE + stream.bytes_written);
    if (om == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const int rc = ble_gatts_notify_custom(active_connection, tx_value_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "FFF2 notify failed: %d", rc);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t send_status(const ai_edgez_halow_NetworkPacket *request)
{
    ai_edgez_halow_NetworkPacket *response = calloc(1, sizeof(*response));
    if (response == NULL) return ESP_ERR_NO_MEM;
    response_base(request, response);
    response->which_body = ai_edgez_halow_NetworkPacket_status_tag;
    fill_status(&response->body.status);
    const esp_err_t err = notify_packet(response);
    free(response);
    return err;
}

static esp_err_t send_device_settings(const ai_edgez_halow_NetworkPacket *request)
{
    ai_edgez_halow_NetworkPacket *response = calloc(1, sizeof(*response));
    if (response == NULL) return ESP_ERR_NO_MEM;
    response_base(request, response);
    response->which_body = ai_edgez_halow_NetworkPacket_device_settings_tag;
    fill_device_settings(&response->body.device_settings);
    const esp_err_t err = notify_packet(response);
    free(response);
    return err;
}

static void apply_init(const ai_edgez_halow_HaLowInitConfig *init)
{
    ESP_LOGI(TAG,
             "Realtime INIT decoded: country='%s' mesh='%s' passphrase_len=%u "
             "frequency_khz=%lu bandwidth_mhz=%lu max_hop=%lu user='%s'",
             init->country_code, init->mesh_id,
             (unsigned)strlen(init->passphrase),
             (unsigned long)init->mesh_frequency_khz,
             (unsigned long)init->mesh_bandwidth_mhz,
             (unsigned long)init->max_hop, init->user_name);
    const bool has_configuration = init->mesh_id[0] != '\0' ||
        init->passphrase[0] != '\0' || init->max_hop != 0 ||
        init->user_id_high != 0 || init->user_id_low != 0 ||
        init->user_name[0] != '\0' || init->user_public_key.size != 0 ||
        init->has_location || init->mesh_frequency_khz != 0 ||
        init->mesh_bandwidth_mhz != 0;
    if (!has_configuration) {
        ESP_LOGI(TAG, "Empty INIT probe received; preserving device profile");
        return;
    }
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (init->country_code[0] != '\0') {
        strlcpy(control_state.country_code, init->country_code,
                sizeof(control_state.country_code));
    }
    if (init->mesh_id[0] != '\0') {
        strlcpy(control_state.mesh_id, init->mesh_id,
                sizeof(control_state.mesh_id));
    }
    strlcpy(control_state.passphrase, init->passphrase,
            sizeof(control_state.passphrase));
    control_state.max_hop = init->max_hop == 0 ? 4 : init->max_hop;
    control_state.user_id_high = init->user_id_high;
    control_state.user_id_low = init->user_id_low;
    strlcpy(control_state.user_name, init->user_name,
            sizeof(control_state.user_name));
    control_state.user_public_key_len = init->user_public_key.size;
    memcpy(control_state.user_public_key, init->user_public_key.bytes,
           init->user_public_key.size);
    control_state.marker = marker_from_name(init->marker);
    control_state.share_location = init->has_location;
    control_state.latitude = init->latitude;
    control_state.longitude = init->longitude;
    if (init->mesh_frequency_khz != 0) {
        control_state.frequency_khz = init->mesh_frequency_khz;
    }
    if (init->mesh_bandwidth_mhz != 0) {
        control_state.bandwidth_mhz = (uint8_t)init->mesh_bandwidth_mhz;
    }
    xSemaphoreGive(state_lock);

    if (init->country_code[0] != '\0' && init->mesh_id[0] != '\0' &&
        mesh_init_signal != NULL) {
        xSemaphoreGive(mesh_init_signal);
    }
}

static void apply_device_settings(const ai_edgez_halow_DeviceSettings *settings)
{
    if (settings->action !=
        ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_SET) {
        return;
    }
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (settings->mesh_id[0] != '\0') {
        strlcpy(control_state.mesh_id, settings->mesh_id,
                sizeof(control_state.mesh_id));
    }
    if (settings->user_name[0] != '\0') {
        strlcpy(control_state.user_name, settings->user_name,
                sizeof(control_state.user_name));
    }
    if (settings->user_id_high != 0 || settings->user_id_low != 0) {
        control_state.user_id_high = settings->user_id_high;
        control_state.user_id_low = settings->user_id_low;
    }
    if (settings->user_public_key.size != 0) {
        control_state.user_public_key_len = settings->user_public_key.size;
        memcpy(control_state.user_public_key, settings->user_public_key.bytes,
               settings->user_public_key.size);
    }
    control_state.share_location = settings->share_location;
    control_state.latitude = settings->latitude;
    control_state.longitude = settings->longitude;
    control_state.marker = settings->marker;
    if (settings->beacon_interval_seconds != 0) {
        control_state.beacon_interval_seconds =
            settings->beacon_interval_seconds;
    }
    if (settings->max_hop != 0) control_state.max_hop = settings->max_hop;
    if (settings->mesh_frequency_khz != 0) {
        control_state.frequency_khz = settings->mesh_frequency_khz;
    }
    if (settings->mesh_bandwidth_mhz != 0) {
        control_state.bandwidth_mhz =
            (uint8_t)settings->mesh_bandwidth_mhz;
    }
    if (settings->passphrase[0] != '\0') {
        strlcpy(control_state.passphrase, settings->passphrase,
                sizeof(control_state.passphrase));
    }
    xSemaphoreGive(state_lock);
}

static esp_err_t handle_packet(const uint8_t *payload, size_t length)
{
    ai_edgez_halow_NetworkPacket *request = calloc(1, sizeof(*request));
    if (request == NULL) return ESP_ERR_NO_MEM;
    pb_istream_t stream = pb_istream_from_buffer(payload, length);
    if (!pb_decode(&stream, ai_edgez_halow_NetworkPacket_fields, request)) {
        ESP_LOGW(TAG, "NetworkPacket decode failed: %s", PB_GET_ERROR(&stream));
        free(request);
        return ESP_ERR_INVALID_ARG;
    }

    ESP_LOGI(TAG, "Control request body=%u operation=%u", request->which_body,
             request->operation);
    esp_err_t err;
    if (request->which_body == ai_edgez_halow_NetworkPacket_init_tag) {
        apply_init(&request->body.init);
        err = send_status(request);
    } else if (request->which_body == ai_edgez_halow_NetworkPacket_device_settings_tag) {
        apply_device_settings(&request->body.device_settings);
        err = send_device_settings(request);
    } else if (request->which_body == ai_edgez_halow_NetworkPacket_status_tag ||
               request->which_body == 0) {
        err = send_status(request);
    } else {
        ESP_LOGW(TAG, "Unsupported control request body=%u", request->which_body);
        err = ESP_ERR_NOT_SUPPORTED;
    }
    free(request);
    return err;
}

static void process_rx_frames(void)
{
    while (rx_length >= EDGEZ_FRAME_HEADER_SIZE) {
        if (rx_buffer[0] != 'E' || rx_buffer[1] != 'Z') {
            ESP_LOGW(TAG, "Invalid control frame magic; clearing RX buffer");
            rx_length = 0;
            return;
        }
        const size_t payload_length =
            (size_t)rx_buffer[2] | ((size_t)rx_buffer[3] << 8);
        const size_t frame_length = EDGEZ_FRAME_HEADER_SIZE + payload_length;
        if (payload_length > EDGEZ_MAX_PACKET_SIZE) {
            ESP_LOGW(TAG, "Control frame too large: %u", (unsigned)payload_length);
            rx_length = 0;
            return;
        }
        if (rx_length < frame_length) return;
        const esp_err_t err = handle_packet(
            &rx_buffer[EDGEZ_FRAME_HEADER_SIZE], payload_length);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Control packet failed: %s", esp_err_to_name(err));
        }
        rx_length -= frame_length;
        if (rx_length != 0) {
            memmove(rx_buffer, &rx_buffer[frame_length], rx_length);
        }
    }
}

static void status_task(void *argument)
{
    (void)argument;
    while (true) {
        (void)ulTaskNotifyTake(pdTRUE,
                               pdMS_TO_TICKS(EDGEZ_STATUS_INTERVAL_MS));
        bool send_settings = false;
        xSemaphoreTake(state_lock, portMAX_DELAY);
        if (notifications_enabled && settings_reports_remaining > 0) {
            --settings_reports_remaining;
            send_settings = true;
        }
        xSemaphoreGive(state_lock);
        if (send_settings) {
            (void)send_device_settings(NULL);
            vTaskDelay(pdMS_TO_TICKS(25));
        }
        (void)send_status(NULL);
    }
}

static int control_access(uint16_t connection_handle,
                          uint16_t attribute_handle,
                          struct ble_gatt_access_ctxt *context,
                          void *argument)
{
    (void)connection_handle;
    (void)attribute_handle;
    const uint16_t characteristic = (uint16_t)(uintptr_t)argument;

    if (characteristic == EDGEZ_CONTROL_RX_UUID &&
        context->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        const uint16_t length = OS_MBUF_PKTLEN(context->om);
        if (length > sizeof(rx_buffer) - rx_length) {
            ESP_LOGW(TAG, "FFF1 RX overflow write=%u buffered=%u", length,
                     (unsigned)rx_length);
            rx_length = 0;
            return BLE_ATT_ERR_INSUFFICIENT_RES;
        }
        uint16_t copied = 0;
        const int rc = ble_hs_mbuf_to_flat(context->om,
                                           &rx_buffer[rx_length], length,
                                           &copied);
        if (rc != 0 || copied != length) {
            ESP_LOGW(TAG, "FFF1 RX copy failed rc=%d copied=%u length=%u",
                     rc, copied, length);
            return BLE_ATT_ERR_UNLIKELY;
        }
        rx_length += copied;
        ESP_LOGI(TAG, "FFF1 control write received: %u bytes buffered=%u",
                 length, (unsigned)rx_length);
        process_rx_frames();
        return 0;
    }
    if (characteristic == EDGEZ_CONTROL_TX_UUID &&
        context->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        return 0;
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def control_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(EDGEZ_CONTROL_SERVICE_UUID),
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = BLE_UUID16_DECLARE(EDGEZ_CONTROL_RX_UUID),
                .access_cb = control_access,
                .arg = (void *)(uintptr_t)EDGEZ_CONTROL_RX_UUID,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = BLE_UUID16_DECLARE(EDGEZ_CONTROL_TX_UUID),
                .access_cb = control_access,
                .arg = (void *)(uintptr_t)EDGEZ_CONTROL_TX_UUID,
                .val_handle = &tx_value_handle,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {0},
        },
    },
    {0},
};

static int start_advertising(void);

static int gap_event(struct ble_gap_event *event, void *argument)
{
    (void)argument;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            ESP_LOGI(TAG, "EdgeZ BLE control connected");
            xSemaphoreTake(state_lock, portMAX_DELAY);
            connection_handle = event->connect.conn_handle;
            notifications_enabled = false;
            settings_reports_remaining = 0;
            rx_length = 0;
            xSemaphoreGive(state_lock);
            const int rc = ble_gap_update_params(event->connect.conn_handle,
                                                 &low_power_connection);
            if (rc != 0) {
                ESP_LOGW(TAG, "Could not request low-power BLE parameters: %d", rc);
            }
            return 0;
        }
        ESP_LOGW(TAG, "BLE connection failed: %d", event->connect.status);
        return start_advertising();
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "EdgeZ BLE control disconnected: %d",
                 event->disconnect.reason);
        xSemaphoreTake(state_lock, portMAX_DELAY);
        connection_handle = EDGEZ_INVALID_CONNECTION_HANDLE;
        notifications_enabled = false;
        settings_reports_remaining = 0;
        rx_length = 0;
        xSemaphoreGive(state_lock);
        return start_advertising();
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == tx_value_handle) {
            xSemaphoreTake(state_lock, portMAX_DELAY);
            notifications_enabled = event->subscribe.cur_notify != 0;
            settings_reports_remaining = notifications_enabled ? 3 : 0;
            xSemaphoreGive(state_lock);
            ESP_LOGI(TAG, "FFF2 notifications %s",
                     event->subscribe.cur_notify ? "enabled" : "disabled");
            if (event->subscribe.cur_notify && status_task_handle != NULL) {
                xTaskNotifyGive(status_task_handle);
            }
        }
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        return start_advertising();
    case BLE_GAP_EVENT_CONN_UPDATE: {
        struct ble_gap_conn_desc description;
        const int rc = ble_gap_conn_find(event->conn_update.conn_handle,
                                         &description);
        if (event->conn_update.status == 0 && rc == 0) {
            ESP_LOGI(TAG,
                     "BLE low-power link interval=%.2f ms latency=%u timeout=%u ms",
                     description.conn_itvl * 1.25,
                     description.conn_latency,
                     description.supervision_timeout * 10);
        } else {
            ESP_LOGW(TAG, "BLE parameter update failed status=%d rc=%d",
                     event->conn_update.status, rc);
        }
        return 0;
    }
    default:
        return 0;
    }
}

static int start_advertising(void)
{
    struct ble_hs_adv_fields advertisement = {0};
    const ble_uuid16_t service = BLE_UUID16_INIT(EDGEZ_CONTROL_SERVICE_UUID);
    advertisement.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    advertisement.uuids16 = &service;
    advertisement.num_uuids16 = 1;
    advertisement.uuids16_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&advertisement);
    if (rc != 0) {
        ESP_LOGE(TAG, "Could not set FFF0 advertising fields: %d", rc);
        return rc;
    }

    struct ble_hs_adv_fields response = {0};
    const char *name = ble_svc_gap_device_name();
    response.name = (const uint8_t *)name;
    response.name_len = strlen(name);
    response.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&response);
    if (rc != 0) {
        ESP_LOGE(TAG, "Could not set BLE scan response: %d", rc);
        return rc;
    }

    struct ble_gap_adv_params parameters = {0};
    parameters.conn_mode = BLE_GAP_CONN_MODE_UND;
    parameters.disc_mode = BLE_GAP_DISC_MODE_GEN;
    parameters.itvl_min = BLE_GAP_ADV_ITVL_MS(500);
    parameters.itvl_max = BLE_GAP_ADV_ITVL_MS(750);
    rc = ble_gap_adv_start(own_address_type, NULL, BLE_HS_FOREVER,
                           &parameters, gap_event, NULL);
    if (rc == 0) {
        ESP_LOGI(TAG, "Advertising %s service=FFF0 rx=FFF1 tx=FFF2", name);
    } else {
        ESP_LOGE(TAG, "Could not start BLE advertising: %d", rc);
    }
    return rc;
}

static void host_sync(void)
{
    const int rc = ble_hs_id_infer_auto(0, &own_address_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "Could not determine BLE address type: %d", rc);
        return;
    }
    (void)start_advertising();
}

static void host_reset(int reason)
{
    ESP_LOGW(TAG, "NimBLE host reset: %d", reason);
}

static void host_task(void *argument)
{
    (void)argument;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void edgez_ble_control_set_radio_profile(const char *country_code,
                                         const char *mesh_id,
                                         const char *passphrase,
                                         uint32_t frequency_khz,
                                         uint8_t bandwidth_mhz)
{
    if (state_lock == NULL) return;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    strlcpy(control_state.country_code, country_code == NULL ? "" : country_code,
            sizeof(control_state.country_code));
    strlcpy(control_state.mesh_id, mesh_id == NULL ? "" : mesh_id,
            sizeof(control_state.mesh_id));
    strlcpy(control_state.passphrase, passphrase == NULL ? "" : passphrase,
            sizeof(control_state.passphrase));
    control_state.frequency_khz = frequency_khz;
    control_state.bandwidth_mhz = bandwidth_mhz;
    xSemaphoreGive(state_lock);
}

void edgez_ble_control_note_mesh_started(const uint8_t mac[6])
{
    if (state_lock == NULL) return;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (mac != NULL) memcpy(control_state.mac, mac, sizeof(control_state.mac));
    control_state.stack_initialized = true;
    xSemaphoreGive(state_lock);
    if (status_task_handle != NULL) xTaskNotifyGive(status_task_handle);
}

void edgez_ble_control_note_mesh_link(int state)
{
    if (state_lock == NULL) return;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    control_state.link_up = state == 2;
    control_state.route_ready = state == 2;
    xSemaphoreGive(state_lock);
    if (status_task_handle != NULL) xTaskNotifyGive(status_task_handle);
}

esp_err_t edgez_ble_control_wait_for_mesh_init(char country_code[3],
                                               char mesh_id[33],
                                               char passphrase[65],
                                               uint32_t *frequency_khz,
                                               uint8_t *bandwidth_mhz)
{
    if (state_lock == NULL || mesh_init_signal == NULL ||
        country_code == NULL || mesh_id == NULL || passphrase == NULL ||
        frequency_khz == NULL || bandwidth_mhz == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(mesh_init_signal, portMAX_DELAY) != pdTRUE) {
        return ESP_FAIL;
    }

    xSemaphoreTake(state_lock, portMAX_DELAY);
    strlcpy(country_code, control_state.country_code, 3);
    strlcpy(mesh_id, control_state.mesh_id, 33);
    strlcpy(passphrase, control_state.passphrase, 65);
    *frequency_khz = control_state.frequency_khz;
    *bandwidth_mhz = control_state.bandwidth_mhz;
    xSemaphoreGive(state_lock);

    return country_code[0] != '\0' && mesh_id[0] != '\0'
               ? ESP_OK
               : ESP_ERR_INVALID_ARG;
}

esp_err_t edgez_ble_control_start(void)
{
    if (started) {
        return ESP_OK;
    }

    state_lock = xSemaphoreCreateMutex();
    if (state_lock == NULL) {
        return ESP_ERR_NO_MEM;
    }
    mesh_init_signal = xSemaphoreCreateBinary();
    if (mesh_init_signal == NULL) {
        vSemaphoreDelete(state_lock);
        state_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed: %s", esp_err_to_name(err));
        return err;
    }

    ble_hs_cfg.reset_cb = host_reset;
    ble_hs_cfg.sync_cb = host_sync;
    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(control_services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(control_services);
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "Could not register FFF0 control service: %d", rc);
        (void)nimble_port_deinit();
        return ESP_FAIL;
    }

    uint8_t mac[6] = {0};
    char name[24] = "EZ_DEVICE";
#if CONFIG_IDF_TARGET_ESP32P4
    const esp_err_t mac_err = esp_wifi_get_mac(WIFI_IF_STA, mac);
#else
    const esp_err_t mac_err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
#endif
    if (mac_err == ESP_OK) {
        snprintf(name, sizeof(name), "EZ_%02X%02X%02X%02X%02X%02X",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    } else {
        ESP_LOGW(TAG, "Could not read BLE identity MAC: %s",
                 esp_err_to_name(mac_err));
    }
    rc = ble_svc_gap_device_name_set(name);
    if (rc != 0) {
        ESP_LOGE(TAG, "Could not set BLE device name: %d", rc);
        (void)nimble_port_deinit();
        return ESP_FAIL;
    }

    if (xTaskCreate(status_task, "edgez_status", 4096, NULL, 5,
                    &status_task_handle) != pdPASS) {
        ESP_LOGE(TAG, "Could not start BLE status task");
        (void)nimble_port_deinit();
        return ESP_ERR_NO_MEM;
    }

    nimble_port_freertos_init(host_task);
    started = true;
    return ESP_OK;
}
