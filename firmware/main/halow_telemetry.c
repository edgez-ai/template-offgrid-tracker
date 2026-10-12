#include "halow_telemetry.h"
#include "esp_heap_caps.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "driver/gpio.h"
#if CONFIG_HALOW_EDGEZ_BATMAN
#include "edgez_mesh.h"
#endif
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mmwlan.h"

#define BEACON_SENSOR_FIELD 101U
#define MAX_BEACON_SENSORS 11U
#define SENSOR_LATITUDE 3U
#define SENSOR_LONGITUDE 4U
#define SENSOR_BATTERY_VOLTAGE 12U
#define LOCAL_REPORT_INTERVAL_MS 30000U
#define PROTOBUF_BUFFER_SIZE 768U
#define TOPOLOGY_MAX_AGE_MS 120000U

#if CONFIG_IDF_TARGET_ESP32S3
#define BATTERY_ENABLE_GPIO GPIO_NUM_20
#define BATTERY_ADC_CHANNEL ADC_CHANNEL_0
#endif

static const char *TAG = "halow_telemetry";

struct local_report_config {
    char client_id[64];
    uint8_t halow_mac[6];
    uint8_t channel;
    uint32_t frequency_khz;
    uint8_t bandwidth_mhz;
    bool publish_system_status;
    bool batman_metrics;
    halow_telemetry_publish_fn_t publish_fn;
    halow_telemetry_ready_fn_t ready_fn;
    void *publisher_arg;
};

static struct local_report_config local_config;
static TaskHandle_t local_report_task_handle;

#if CONFIG_IDF_TARGET_ESP32S3
static adc_oneshot_unit_handle_t battery_adc;
static adc_cali_handle_t battery_calibration;
static bool battery_ready;
#endif

enum sensor_value_kind {
    SENSOR_VALUE_NONE,
    SENSOR_VALUE_BOOL,
    SENSOR_VALUE_INT,
    SENSOR_VALUE_FLOAT,
};

struct decoded_sensor {
    uint32_t type;
    enum sensor_value_kind kind;
    union {
        bool boolean;
        int32_t integer;
        float floating;
    } value;
};

struct decoded_beacon {
    uint64_t user_id_high;
    uint64_t user_id_low;
    float latitude;
    float longitude;
    bool has_latitude;
    bool has_longitude;
    size_t sensor_count;
    struct decoded_sensor sensors[MAX_BEACON_SENSORS];
};

static bool read_varint(const uint8_t **cursor, const uint8_t *end, uint64_t *value)
{
    uint64_t result = 0;
    unsigned shift = 0;
    while (*cursor < end && shift < 64) {
        const uint8_t byte = *(*cursor)++;
        result |= (uint64_t)(byte & 0x7fU) << shift;
        if ((byte & 0x80U) == 0) {
            *value = result;
            return true;
        }
        shift += 7;
    }
    return false;
}

static bool read_fixed32(const uint8_t **cursor, const uint8_t *end, uint32_t *value)
{
    if ((size_t)(end - *cursor) < sizeof(*value)) {
        return false;
    }
    const uint8_t *data = *cursor;
    *value = (uint32_t)data[0] | ((uint32_t)data[1] << 8) |
             ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
    *cursor += sizeof(*value);
    return true;
}

static bool skip_field(uint32_t wire_type, const uint8_t **cursor, const uint8_t *end)
{
    uint64_t length;
    switch (wire_type) {
        case 0:
            return read_varint(cursor, end, &length);
        case 1:
            if ((size_t)(end - *cursor) < 8) return false;
            *cursor += 8;
            return true;
        case 2:
            if (!read_varint(cursor, end, &length) || length > (uint64_t)(end - *cursor)) {
                return false;
            }
            *cursor += (size_t)length;
            return true;
        case 5:
            if ((size_t)(end - *cursor) < 4) return false;
            *cursor += 4;
            return true;
        default:
            return false;
    }
}

static bool decode_sensor(const uint8_t *data,
                          size_t length,
                          struct decoded_sensor *sensor)
{
    const uint8_t *cursor = data;
    const uint8_t *end = data + length;
    memset(sensor, 0, sizeof(*sensor));
    while (cursor < end) {
        uint64_t key;
        if (!read_varint(&cursor, end, &key) || key == 0) return false;
        const uint32_t field = (uint32_t)(key >> 3);
        const uint32_t wire_type = (uint32_t)(key & 7U);
        uint64_t value;
        uint32_t fixed;
        if (field == 1 && wire_type == 0) {
            if (!read_varint(&cursor, end, &value)) return false;
            sensor->type = (uint32_t)value;
        } else if (field == 2 && wire_type == 0) {
            if (!read_varint(&cursor, end, &value)) return false;
            sensor->kind = SENSOR_VALUE_BOOL;
            sensor->value.boolean = value != 0;
        } else if (field == 3 && wire_type == 0) {
            if (!read_varint(&cursor, end, &value)) return false;
            sensor->kind = SENSOR_VALUE_INT;
            sensor->value.integer = (int32_t)((value >> 1) ^ (uint64_t)-(int64_t)(value & 1U));
        } else if (field == 4 && wire_type == 5) {
            if (!read_fixed32(&cursor, end, &fixed)) return false;
            sensor->kind = SENSOR_VALUE_FLOAT;
            memcpy(&sensor->value.floating, &fixed, sizeof(fixed));
        } else if (!skip_field(wire_type, &cursor, end)) {
            return false;
        }
    }
    return sensor->kind != SENSOR_VALUE_NONE;
}

static bool decode_beacon(const uint8_t *data,
                          size_t length,
                          struct decoded_beacon *beacon)
{
    const uint8_t *cursor = data;
    const uint8_t *end = data + length;
    memset(beacon, 0, sizeof(*beacon));
    while (cursor < end) {
        uint64_t key;
        if (!read_varint(&cursor, end, &key) || key == 0) return false;
        const uint32_t field = (uint32_t)(key >> 3);
        const uint32_t wire_type = (uint32_t)(key & 7U);
        uint64_t value;
        uint32_t fixed;
        if ((field == 1 || field == 2) && wire_type == 0) {
            if (!read_varint(&cursor, end, &value)) return false;
            if (field == 1) beacon->user_id_high = value;
            else beacon->user_id_low = value;
        } else if ((field == 5 || field == 6) && wire_type == 5) {
            if (!read_fixed32(&cursor, end, &fixed)) return false;
            float coordinate;
            memcpy(&coordinate, &fixed, sizeof(fixed));
            if (field == 5) {
                beacon->latitude = coordinate;
                beacon->has_latitude = true;
            } else {
                beacon->longitude = coordinate;
                beacon->has_longitude = true;
            }
        } else if (field == BEACON_SENSOR_FIELD && wire_type == 2) {
            if (!read_varint(&cursor, end, &value) || value > (uint64_t)(end - cursor)) {
                return false;
            }
            if (beacon->sensor_count < MAX_BEACON_SENSORS &&
                decode_sensor(cursor, (size_t)value,
                              &beacon->sensors[beacon->sensor_count])) {
                ++beacon->sensor_count;
            }
            cursor += (size_t)value;
        } else if (!skip_field(wire_type, &cursor, end)) {
            return false;
        }
    }
    return beacon->user_id_high != 0 || beacon->user_id_low != 0;
}

static bool has_sensor_type(const struct decoded_beacon *beacon, uint32_t type)
{
    for (size_t index = 0; index < beacon->sensor_count; ++index) {
        if (beacon->sensors[index].type == type) return true;
    }
    return false;
}

static bool append_sensor(cJSON *sensors, const struct decoded_sensor *sensor)
{
    cJSON *record = cJSON_CreateObject();
    cJSON *value = NULL;
    if (record == NULL) return false;
    switch (sensor->kind) {
        case SENSOR_VALUE_BOOL:
            value = cJSON_CreateBool(sensor->value.boolean);
            break;
        case SENSOR_VALUE_INT:
            value = cJSON_CreateNumber(sensor->value.integer);
            break;
        case SENSOR_VALUE_FLOAT:
            if (isfinite(sensor->value.floating)) {
                value = cJSON_CreateNumber(sensor->value.floating);
            }
            break;
        default:
            break;
    }
    if (value == NULL) {
        cJSON_Delete(record);
        return false;
    }
    cJSON_AddNumberToObject(record, "type", sensor->type);
    cJSON_AddItemToObject(record, "value", value);
    cJSON_AddItemToArray(sensors, record);
    return true;
}

esp_err_t halow_telemetry_forward_beacon(const uint8_t *data, size_t length)
{
    if (data == NULL || length == 0) return ESP_ERR_INVALID_ARG;

    struct decoded_beacon beacon;
    if (!decode_beacon(data, length, &beacon)) {
        ESP_LOGW(TAG, "PAwR Beacon protobuf decode failed, bytes=%u", (unsigned)length);
        return ESP_ERR_INVALID_RESPONSE;
    }

    char client_id[37];
    snprintf(client_id, sizeof(client_id),
             "%08llx-%04llx-%04llx-%04llx-%012llx",
             (unsigned long long)(beacon.user_id_high >> 32),
             (unsigned long long)((beacon.user_id_high >> 16) & 0xffffU),
             (unsigned long long)(beacon.user_id_high & 0xffffU),
             (unsigned long long)(beacon.user_id_low >> 48),
             (unsigned long long)(beacon.user_id_low & UINT64_C(0xffffffffffff)));

    cJSON *batch = cJSON_CreateArray();
    cJSON *entry = cJSON_CreateObject();
    cJSON *sensors = cJSON_CreateArray();
    if (batch == NULL || entry == NULL || sensors == NULL) {
        cJSON_Delete(batch);
        cJSON_Delete(entry);
        cJSON_Delete(sensors);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(entry, "clientId", client_id);
    size_t forwarded_sensors = 0;
    for (size_t index = 0; index < beacon.sensor_count; ++index) {
        if (append_sensor(sensors, &beacon.sensors[index])) ++forwarded_sensors;
    }
    if (beacon.has_latitude && beacon.has_longitude &&
        isfinite(beacon.latitude) && isfinite(beacon.longitude) &&
        beacon.latitude >= -90.0f && beacon.latitude <= 90.0f &&
        beacon.longitude >= -180.0f && beacon.longitude <= 180.0f &&
        (beacon.latitude != 0.0f || beacon.longitude != 0.0f)) {
        if (!has_sensor_type(&beacon, SENSOR_LATITUDE)) {
            const struct decoded_sensor latitude = {
                .type = SENSOR_LATITUDE,
                .kind = SENSOR_VALUE_FLOAT,
                .value.floating = beacon.latitude,
            };
            if (append_sensor(sensors, &latitude)) ++forwarded_sensors;
        }
        if (!has_sensor_type(&beacon, SENSOR_LONGITUDE)) {
            const struct decoded_sensor longitude = {
                .type = SENSOR_LONGITUDE,
                .kind = SENSOR_VALUE_FLOAT,
                .value.floating = beacon.longitude,
            };
            if (append_sensor(sensors, &longitude)) ++forwarded_sensors;
        }
    }
    if (forwarded_sensors == 0) {
        ESP_LOGW(TAG, "PAwR Beacon client=%s contains no publishable sensors", client_id);
        cJSON_Delete(batch);
        cJSON_Delete(entry);
        cJSON_Delete(sensors);
        return ESP_ERR_NOT_FOUND;
    }
    cJSON_AddItemToObject(entry, "sensors", sensors);
    cJSON_AddItemToArray(batch, entry);
    char *payload = cJSON_PrintUnformatted(batch);
    if (payload == NULL) {
        cJSON_Delete(batch);
        return ESP_ERR_NO_MEM;
    }

    const size_t payload_length = strlen(payload);
    if (local_config.publish_fn == NULL) {
        cJSON_free(payload);
        cJSON_Delete(batch);
        return ESP_ERR_INVALID_STATE;
    }
    const int message_id = local_config.publish_fn(
        "telemetry/sensors", payload, payload_length, 0, false,
        local_config.publisher_arg);
    if (message_id < 0) {
        ESP_LOGW(TAG,
                 "PAwR telemetry not published client=%s sensors=%u: MQTT unavailable",
                 client_id, (unsigned)forwarded_sensors);
    } else {
        ESP_LOGI(TAG,
                 "PAwR telemetry published client=%s sensors=%u bytes=%u message_id=%d",
                 client_id, (unsigned)forwarded_sensors,
                 (unsigned)payload_length, message_id);
    }
    cJSON_free(payload);
    cJSON_Delete(batch);
    return message_id >= 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static bool protobuf_put_varint(uint8_t *buffer,
                                size_t capacity,
                                size_t *offset,
                                uint64_t value)
{
    do {
        if (*offset >= capacity) return false;
        uint8_t byte = (uint8_t)(value & 0x7fU);
        value >>= 7;
        if (value != 0) byte |= 0x80U;
        buffer[(*offset)++] = byte;
    } while (value != 0);
    return true;
}

static bool protobuf_put_key(uint8_t *buffer,
                             size_t capacity,
                             size_t *offset,
                             uint32_t field,
                             uint32_t wire_type)
{
    return protobuf_put_varint(buffer, capacity, offset,
                               ((uint64_t)field << 3) | wire_type);
}

static bool protobuf_put_bytes(uint8_t *buffer,
                               size_t capacity,
                               size_t *offset,
                               uint32_t field,
                               const void *data,
                               size_t length)
{
    if (!protobuf_put_key(buffer, capacity, offset, field, 2) ||
        !protobuf_put_varint(buffer, capacity, offset, length) ||
        length > capacity - *offset) {
        return false;
    }
    memcpy(buffer + *offset, data, length);
    *offset += length;
    return true;
}

static bool protobuf_put_u64(uint8_t *buffer,
                             size_t capacity,
                             size_t *offset,
                             uint32_t field,
                             uint64_t value)
{
    return protobuf_put_key(buffer, capacity, offset, field, 0) &&
           protobuf_put_varint(buffer, capacity, offset, value);
}

static bool protobuf_put_s32(uint8_t *buffer,
                             size_t capacity,
                             size_t *offset,
                             uint32_t field,
                             int32_t value)
{
    const uint32_t zigzag = ((uint32_t)value << 1) ^
                            (uint32_t)(value >> 31);
    return protobuf_put_u64(buffer, capacity, offset, field, zigzag);
}

static bool encode_local_topology(uint8_t *output,
                                  size_t capacity,
                                  size_t *output_length,
                                  size_t *peer_count)
{
#if CONFIG_HALOW_EDGEZ_BATMAN
    if (!local_config.batman_metrics) {
        *output_length = 0;
        *peer_count = 0;
        return true;
    }
    edgez_batadv_route_snapshot_t routes[EDGEZ_BATADV_MAX_ROUTES];
    const size_t route_count = edgez_mesh_snapshot_routes(
        routes, sizeof(routes) / sizeof(routes[0]));
    edgez_mesh_rf_metrics_t rf_metrics = {0};
    const bool rssi_valid = edgez_mesh_snapshot_rf_metrics(&rf_metrics) &&
                            rf_metrics.signal_valid;
    const int16_t rssi_dbm = rf_metrics.average_signal_dbm;
    size_t length = 0;
    size_t included = 0;
    for (size_t index = 0; index < route_count; ++index) {
        if (routes[index].age_ms > TOPOLOGY_MAX_AGE_MS) continue;
        uint8_t link[24];
        size_t link_length = 0;
        if (!protobuf_put_bytes(link, sizeof(link), &link_length, 1,
                                routes[index].originator,
                                sizeof(routes[index].originator)) ||
            !protobuf_put_u64(link, sizeof(link), &link_length, 2,
                              routes[index].age_ms) ||
            (rssi_valid &&
             !protobuf_put_s32(link, sizeof(link), &link_length, 3,
                               rssi_dbm)) ||
            !protobuf_put_bytes(output, capacity, &length, 1,
                                link, link_length)) {
            return false;
        }
        ++included;
    }
    *output_length = length;
    *peer_count = included;
    return true;
#else
    (void)output;
    (void)capacity;
    *output_length = 0;
    *peer_count = 0;
    return true;
#endif
}

struct local_rf_metrics {
    uint8_t peer_count;
    bool radio_enabled;
    bool available;
    bool signal_valid;
    bool noise_valid;
    int16_t average_signal_dbm;
    int16_t minimum_signal_dbm;
    int16_t noise_dbm;
    uint32_t rx_packets;
    uint32_t tx_packets;
    uint32_t tx_retries;
    uint32_t tx_failed;
};

static bool encode_local_system_status(uint8_t output[PROTOBUF_BUFFER_SIZE],
                                       size_t *output_length)
{
    uint8_t topology[384];
    size_t topology_length = 0;
    size_t peer_count = 0;
    bool ok = encode_local_topology(topology, sizeof(topology),
                                    &topology_length, &peer_count);

    struct local_rf_metrics metrics = {0};
#if CONFIG_HALOW_EDGEZ_BATMAN
    if (local_config.batman_metrics) {
        edgez_mesh_rf_metrics_t snapshot = {0};
        ok = ok && edgez_mesh_snapshot_rf_metrics(&snapshot);
        metrics.peer_count = snapshot.peer_count;
        metrics.radio_enabled = snapshot.radio_enabled;
        metrics.available = snapshot.available;
        metrics.signal_valid = snapshot.signal_valid;
        metrics.noise_valid = snapshot.noise_valid;
        metrics.average_signal_dbm = snapshot.average_signal_dbm;
        metrics.minimum_signal_dbm = snapshot.minimum_signal_dbm;
        metrics.noise_dbm = snapshot.noise_dbm;
        metrics.rx_packets = snapshot.rx_packets;
        metrics.tx_packets = snapshot.tx_packets;
        metrics.tx_retries = snapshot.tx_retries;
        metrics.tx_failed = snapshot.tx_failed;
    }
#endif

    uint8_t rf_links[64];
    size_t rf_links_length = 0;
    ok = ok && protobuf_put_u64(rf_links, sizeof(rf_links),
                                &rf_links_length, 1, metrics.peer_count);
    if (metrics.signal_valid) {
        ok = ok && protobuf_put_s32(rf_links, sizeof(rf_links),
                                    &rf_links_length, 2,
                                    metrics.average_signal_dbm) &&
                  protobuf_put_s32(rf_links, sizeof(rf_links),
                                    &rf_links_length, 3,
                                    metrics.minimum_signal_dbm);
    }
    ok = ok && protobuf_put_u64(rf_links, sizeof(rf_links),
                                &rf_links_length, 4, metrics.rx_packets) &&
              protobuf_put_u64(rf_links, sizeof(rf_links),
                                &rf_links_length, 5, metrics.tx_packets) &&
              protobuf_put_u64(rf_links, sizeof(rf_links),
                                &rf_links_length, 6, metrics.tx_retries) &&
              protobuf_put_u64(rf_links, sizeof(rf_links),
                                &rf_links_length, 7, metrics.tx_failed);

    uint8_t rf[128];
    size_t rf_length = 0;
    const uint64_t observed_at = (uint64_t)(esp_timer_get_time() / 1000000);
    ok = ok && protobuf_put_u64(rf, sizeof(rf), &rf_length, 1, 1) &&
              protobuf_put_u64(rf, sizeof(rf), &rf_length, 2,
                               observed_at != 0 ? observed_at : 1) &&
              protobuf_put_u64(rf, sizeof(rf), &rf_length, 3,
                               metrics.radio_enabled) &&
              protobuf_put_u64(rf, sizeof(rf), &rf_length, 4,
                               metrics.available);
    if (local_config.channel != 0) {
        ok = ok && protobuf_put_u64(rf, sizeof(rf), &rf_length, 5,
                                    local_config.channel);
    }
    if (local_config.frequency_khz != 0) {
        ok = ok && protobuf_put_u64(rf, sizeof(rf), &rf_length, 6,
                                    local_config.frequency_khz);
    }
    if (local_config.bandwidth_mhz != 0) {
        ok = ok && protobuf_put_u64(rf, sizeof(rf), &rf_length, 7,
                                    local_config.bandwidth_mhz);
    }
    if (metrics.signal_valid) {
        int32_t quality = metrics.average_signal_dbm + 110;
        if (quality < 0) quality = 0;
        if (quality > 70) quality = 70;
        ok = ok && protobuf_put_s32(rf, sizeof(rf), &rf_length, 8,
                                    metrics.average_signal_dbm) &&
                  protobuf_put_u64(rf, sizeof(rf), &rf_length, 10,
                                   (uint32_t)quality) &&
                  protobuf_put_u64(rf, sizeof(rf), &rf_length, 11, 70);
    }
    if (metrics.noise_valid) {
        ok = ok && protobuf_put_s32(rf, sizeof(rf), &rf_length, 9,
                                    metrics.noise_dbm);
    }
    ok = ok && protobuf_put_bytes(rf, sizeof(rf), &rf_length, 12,
                                  rf_links, rf_links_length);

    uint8_t status[PROTOBUF_BUFFER_SIZE];
    size_t status_length = 0;
    const esp_app_desc_t *description = esp_app_get_description();
    ok = ok && protobuf_put_bytes(status, sizeof(status), &status_length, 1,
                                  local_config.client_id,
                                  strlen(local_config.client_id)) &&
         protobuf_put_u64(status, sizeof(status), &status_length, 2, 1) &&
         protobuf_put_bytes(status, sizeof(status), &status_length, 3,
                            local_config.halow_mac,
                            sizeof(local_config.halow_mac)) &&
         protobuf_put_bytes(status, sizeof(status), &status_length, 4,
                            description->version, strlen(description->version)) &&
         protobuf_put_bytes(status, sizeof(status), &status_length, 5,
                            topology, topology_length) &&
         protobuf_put_bytes(status, sizeof(status), &status_length, 6,
                            rf, rf_length) &&
         protobuf_put_u64(status, sizeof(status), &status_length, 7,
                          local_config.ready_fn != NULL &&
                                  local_config.ready_fn(local_config.publisher_arg)
                              ? 1 : 2) &&
         protobuf_put_u64(status, sizeof(status), &status_length, 8, 0);
    size_t batch_length = 0;
    ok = ok && protobuf_put_bytes(output, PROTOBUF_BUFFER_SIZE, &batch_length,
                                  1, status, status_length);
    if (ok) {
        *output_length = batch_length;
        ESP_LOGI(TAG,
                 "HaLow RF snapshot peers=%u signal=%d valid=%u noise=%d valid=%u rx=%lu tx=%lu retry=%lu failed=%lu",
                 (unsigned)metrics.peer_count,
                 (int)metrics.average_signal_dbm,
                 metrics.signal_valid ? 1U : 0U,
                 (int)metrics.noise_dbm,
                 metrics.noise_valid ? 1U : 0U,
                 (unsigned long)metrics.rx_packets,
                 (unsigned long)metrics.tx_packets,
                 (unsigned long)metrics.tx_retries,
                 (unsigned long)metrics.tx_failed);
    }
    return ok;
}

#if CONFIG_IDF_TARGET_ESP32S3
static esp_err_t battery_init(void)
{
    gpio_config_t enable = {
        .pin_bit_mask = UINT64_C(1) << BATTERY_ENABLE_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    esp_err_t err = gpio_config(&enable);
    if (err == ESP_OK) err = gpio_set_level(BATTERY_ENABLE_GPIO, 0);
    const adc_oneshot_unit_init_cfg_t unit_config = {
        .unit_id = ADC_UNIT_1,
    };
    if (err == ESP_OK) err = adc_oneshot_new_unit(&unit_config, &battery_adc);
    const adc_oneshot_chan_cfg_t channel_config = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (err == ESP_OK) {
        err = adc_oneshot_config_channel(battery_adc, BATTERY_ADC_CHANNEL,
                                         &channel_config);
    }
    const adc_cali_curve_fitting_config_t calibration_config = {
        .unit_id = ADC_UNIT_1,
        .chan = BATTERY_ADC_CHANNEL,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (err == ESP_OK) {
        err = adc_cali_create_scheme_curve_fitting(&calibration_config,
                                                    &battery_calibration);
    }
    battery_ready = err == ESP_OK;
    return err;
}

static esp_err_t battery_read(float *volts)
{
    if (!battery_ready || volts == NULL) return ESP_ERR_INVALID_STATE;
    esp_err_t err = gpio_set_level(BATTERY_ENABLE_GPIO, 1);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(10));
    int millivolts = 0;
    for (unsigned sample = 0; sample < 16 && err == ESP_OK; ++sample) {
        int raw;
        int sample_mv;
        err = adc_oneshot_read(battery_adc, BATTERY_ADC_CHANNEL, &raw);
        if (err == ESP_OK) {
            err = adc_cali_raw_to_voltage(battery_calibration, raw, &sample_mv);
        }
        if (err == ESP_OK) millivolts += sample_mv;
    }
    gpio_set_level(BATTERY_ENABLE_GPIO, 0);
    if (err == ESP_OK) {
        const int battery_mv = (millivolts / 16) * 2;
        if (battery_mv < 2500 || battery_mv > 5000) return ESP_ERR_INVALID_RESPONSE;
        *volts = battery_mv / 1000.0f;
    }
    return err;
}
#endif

static esp_err_t publish_local_sensors(void)
{
    cJSON *batch = cJSON_CreateArray();
    cJSON *entry = cJSON_CreateObject();
    cJSON *sensors = cJSON_CreateArray();
    if (batch == NULL || entry == NULL || sensors == NULL) {
        cJSON_Delete(batch);
        cJSON_Delete(entry);
        cJSON_Delete(sensors);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(entry, "clientId", local_config.client_id);
#if CONFIG_IDF_TARGET_ESP32S3
    float battery_volts;
    const esp_err_t battery_err = battery_read(&battery_volts);
    if (battery_err == ESP_OK) {
        const struct decoded_sensor battery = {
            .type = SENSOR_BATTERY_VOLTAGE,
            .kind = SENSOR_VALUE_FLOAT,
            .value.floating = battery_volts,
        };
        (void)append_sensor(sensors, &battery);
    } else {
        ESP_LOGW(TAG, "Battery ADC read failed; omitting local sensor batch: %s",
                 esp_err_to_name(battery_err));
    }
#endif
    if (cJSON_GetArraySize(sensors) == 0) {
        /* Match the reference producer: omit telemetry/sensors entirely when
         * the local record has no samples. An empty entry is not telemetry. */
        cJSON_Delete(batch);
        cJSON_Delete(entry);
        cJSON_Delete(sensors);
        return ESP_ERR_NOT_FOUND;
    }
    cJSON_AddItemToObject(entry, "sensors", sensors);
    cJSON_AddItemToArray(batch, entry);
    char *payload = cJSON_PrintUnformatted(batch);
    if (payload == NULL) {
        cJSON_Delete(batch);
        return ESP_ERR_NO_MEM;
    }
    const size_t length = strlen(payload);
    const int message_id = local_config.publish_fn(
        "telemetry/sensors", payload, length, 0, false,
        local_config.publisher_arg);
    if (message_id >= 0) {
        ESP_LOGI(TAG, "Local telemetry/sensors published bytes=%u message_id=%d",
                 (unsigned)length, message_id);
    }
    cJSON_free(payload);
    cJSON_Delete(batch);
    return message_id >= 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

static void local_report_task(void *arg)
{
    /* Private to this task; do not retain a protobuf buffer on the nested
     * publisher -> transport -> radio -> logging call stack. */
    uint8_t *payload = arg;
    while (true) {
        while (!local_config.ready_fn(local_config.publisher_arg)) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        if (local_config.publish_system_status) {
            size_t length = 0;
            if (encode_local_system_status(payload, &length)) {
                const int message_id = local_config.publish_fn(
                    "system/status", payload, length, 0, false,
                    local_config.publisher_arg);
                if (message_id >= 0) {
                    ESP_LOGI(TAG,
                             "Local system/status published bytes=%u message_id=%d",
                             (unsigned)length, message_id);
                }
            } else {
                ESP_LOGE(TAG, "Could not encode local system/status protobuf");
            }
        }
        const esp_err_t sensor_err = publish_local_sensors();
        if (sensor_err != ESP_OK && sensor_err != ESP_ERR_NOT_FOUND) {
            ESP_LOGW(TAG, "Could not publish local sensors: %s",
                     esp_err_to_name(sensor_err));
        }
#if CONFIG_HALOW_EDGEZ_MEMORY_DIAGNOSTICS
        ESP_LOGI(TAG, "halow_report stack_min_bytes=%u",
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));
#endif
        vTaskDelay(pdMS_TO_TICKS(LOCAL_REPORT_INTERVAL_MS));
    }
}

esp_err_t halow_telemetry_start_local(const char *client_id,
                                      const uint8_t halow_mac[6],
                                      uint8_t channel,
                                      uint32_t frequency_khz,
                                      uint8_t bandwidth_mhz,
                                      bool publish_system_status,
                                      bool batman_metrics,
                                      halow_telemetry_publish_fn_t publish_fn,
                                      halow_telemetry_ready_fn_t ready_fn,
                                      void *publisher_arg)
{
    if (client_id == NULL || client_id[0] == '\0' ||
        strlen(client_id) >= sizeof(local_config.client_id) ||
        halow_mac == NULL || publish_fn == NULL || ready_fn == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (local_report_task_handle != NULL) return ESP_ERR_INVALID_STATE;
    strlcpy(local_config.client_id, client_id, sizeof(local_config.client_id));
    memcpy(local_config.halow_mac, halow_mac, sizeof(local_config.halow_mac));
    local_config.channel = channel;
    local_config.frequency_khz = frequency_khz;
    local_config.bandwidth_mhz = bandwidth_mhz;
    local_config.publish_system_status = publish_system_status;
    local_config.batman_metrics = batman_metrics;
    local_config.publish_fn = publish_fn;
    local_config.ready_fn = ready_fn;
    local_config.publisher_arg = publisher_arg;
#if CONFIG_IDF_TARGET_ESP32S3
    const esp_err_t battery_err = battery_init();
    if (battery_err != ESP_OK) {
        ESP_LOGW(TAG, "Local battery telemetry unavailable: %s",
                 esp_err_to_name(battery_err));
    }
#endif
    uint8_t *report_payload = heap_caps_malloc(PROTOBUF_BUFFER_SIZE, MALLOC_CAP_8BIT);
    if (report_payload == NULL) return ESP_ERR_NO_MEM;
    /* ESP-IDF sizes task stacks in bytes. Includes nested JSON/protobuf,
     * MQTT framing, crypto/radio submission and diagnostic logging. */
    if (xTaskCreate(local_report_task, "halow_report", 12288, report_payload, 5,
                    &local_report_task_handle) != pdPASS) {
        heap_caps_free(report_payload);
        local_report_task_handle = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG,
             "Local cloud reporting ready client=%s interval=%u ms",
             local_config.client_id, LOCAL_REPORT_INTERVAL_MS);
    return ESP_OK;
}
