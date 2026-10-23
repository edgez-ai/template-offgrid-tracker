#include "edgez_esp_factory_data.h"

#include <stddef.h>
#include <string.h>

#include "esp_log.h"
#include "esp_partition.h"

#define EDGEZ_FACTORY_MAGIC UINT32_C(0x455a4631)
#define EDGEZ_FACTORY_VERSION 2U

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t version;
    uint16_t length;
    char serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
    uint8_t public_key[EDGEZ_FACTORY_KEY_SIZE];
    uint8_t private_key[EDGEZ_FACTORY_KEY_SIZE];
    char country[EDGEZ_FACTORY_COUNTRY_SIZE];
    char mesh_id[EDGEZ_FACTORY_MESH_ID_SIZE];
    uint8_t channel;
    char passphrase[EDGEZ_FACTORY_PASSPHRASE_SIZE];
    uint32_t crc32;
} edgez_factory_record_t;

static const char *TAG = "edgez_factory";
static edgez_esp_factory_identity_t cached_identity;
static bool identity_ready;

static uint32_t ieee_crc32(const void *data, size_t length)
{
    const uint8_t *bytes = data;
    uint32_t crc = UINT32_C(0xffffffff);
    while (length-- != 0U) {
        crc ^= *bytes++;
        for (unsigned bit = 0; bit < 8U; ++bit) {
            crc = (crc >> 1U) ^ ((crc & 1U) != 0U ?
                UINT32_C(0xedb88320) : 0U);
        }
    }
    return crc ^ UINT32_C(0xffffffff);
}

static bool nonzero_key(const uint8_t key[EDGEZ_FACTORY_KEY_SIZE])
{
    uint8_t combined = 0U;
    for (size_t i = 0; i < EDGEZ_FACTORY_KEY_SIZE; ++i) combined |= key[i];
    return combined != 0U;
}

esp_err_t edgez_esp_factory_data_init(void)
{
    identity_ready = false;
    memset(&cached_identity, 0, sizeof(cached_identity));
    const esp_partition_t *partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, 0x40, "factory_data");
    if (partition == NULL || partition->size < sizeof(edgez_factory_record_t)) {
        ESP_LOGE(TAG, "factory_data partition is unavailable");
        return ESP_ERR_NOT_FOUND;
    }

    edgez_factory_record_t record = {0};
    esp_err_t err = esp_partition_read(partition, 0, &record, sizeof(record));
    const char *passphrase_end = memchr(record.passphrase, '\0',
                                        sizeof(record.passphrase));
    const size_t passphrase_length = passphrase_end == NULL ? SIZE_MAX :
        strlen(record.passphrase);
    const bool profile_present = record.mesh_id[0] != '\0' ||
        passphrase_length != 0U;
    const bool profile_valid = !profile_present ||
        (record.mesh_id[0] != '\0' && record.channel != 0U &&
         (passphrase_length == 0U || passphrase_length >= 8U));
    const bool valid = err == ESP_OK && record.magic == EDGEZ_FACTORY_MAGIC &&
        record.version == EDGEZ_FACTORY_VERSION &&
        record.length == sizeof(record) && record.serial[0] != '\0' &&
        memchr(record.serial, '\0', sizeof(record.serial)) != NULL &&
        nonzero_key(record.public_key) && nonzero_key(record.private_key) &&
        record.country[0] != '\0' && record.country[1] != '\0' &&
        record.country[2] == '\0' &&
        memchr(record.mesh_id, '\0', sizeof(record.mesh_id)) != NULL &&
        profile_valid &&
        record.crc32 == ieee_crc32(&record, offsetof(edgez_factory_record_t, crc32));
    if (!valid) {
        memset(&record, 0, sizeof(record));
        ESP_LOGE(TAG, "factory identity is blank or invalid");
        return err == ESP_OK ? ESP_ERR_INVALID_CRC : err;
    }

    strlcpy(cached_identity.serial, record.serial,
            sizeof(cached_identity.serial));
    memcpy(cached_identity.public_key, record.public_key,
           sizeof(cached_identity.public_key));
    memcpy(cached_identity.private_key, record.private_key,
           sizeof(cached_identity.private_key));
    strlcpy(cached_identity.country, record.country,
            sizeof(cached_identity.country));
    strlcpy(cached_identity.mesh_id, record.mesh_id,
            sizeof(cached_identity.mesh_id));
    cached_identity.channel = record.channel;
    strlcpy(cached_identity.passphrase, record.passphrase,
            sizeof(cached_identity.passphrase));
    cached_identity.has_halow_profile = record.mesh_id[0] != '\0';
    identity_ready = true;
    ESP_LOGI(TAG, "factory identity loaded serial=%s", cached_identity.serial);
    memset(&record, 0, sizeof(record));
    return ESP_OK;
}

esp_err_t edgez_esp_factory_data_get(edgez_esp_factory_identity_t *identity)
{
    if (identity == NULL) return ESP_ERR_INVALID_ARG;
    if (!identity_ready) return ESP_ERR_INVALID_STATE;
    *identity = cached_identity;
    return ESP_OK;
}

bool edgez_esp_factory_data_is_ready(void)
{
    return identity_ready;
}
