#include "livestocking_config.h"

#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/data/json.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/util.h>

#include "edgez_config.h"
#include "edgez_rf_api.h"

LOG_MODULE_REGISTER(livestock_config, LOG_LEVEL_INF);

#define OFFGRID_SETTINGS_KEY "offgrid/device/v1"
#define OFFGRID_MAGIC 0x4f464731U

struct provisioning_json {
	char *client_id;
	char *mesh_id;
	char *passphrase;
	char *country;
	char *device_name;
	char *confirmation_id;
	bool use_device_gps;
	int32_t halow_channel;
	int32_t halow_frequency_khz;
	double latitude;
	double longitude;
};

static const struct json_obj_descr provisioning_descr[] = {
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "clientId", client_id, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "meshId", mesh_id, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM(struct provisioning_json, passphrase, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM(struct provisioning_json, country, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "halowChannel", halow_channel, JSON_TOK_NUMBER),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "halowFrequencyKHz", halow_frequency_khz, JSON_TOK_NUMBER),
	JSON_OBJ_DESCR_PRIM(struct provisioning_json, latitude, JSON_TOK_DOUBLE_FP),
	JSON_OBJ_DESCR_PRIM(struct provisioning_json, longitude, JSON_TOK_DOUBLE_FP),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "deviceName", device_name, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "confirmationId", confirmation_id, JSON_TOK_STRING),
	JSON_OBJ_DESCR_PRIM_NAMED(struct provisioning_json, "useDeviceGps", use_device_gps, JSON_TOK_TRUE),
};

struct offline_saved_config {
	uint32_t magic;
	char country[3];
	char device_id[37];
};

static struct offline_saved_config saved = { .country = CONFIG_WIFI_MORSEMICRO_REGION };

static bool valid_string(const char *value, size_t capacity)
{
	return value && value[0] && strlen(value) < capacity;
}

static int parse_device_uuid(const char *value, uint64_t *high, uint64_t *low)
{
	uint64_t halves[2] = {0};
	size_t digits = 0;

	if (!value || strlen(value) != 36 || !high || !low) return -EINVAL;
	for (size_t i = 0; i < 36; ++i) {
		char c = value[i];
		uint8_t nibble;
		if (i == 8 || i == 13 || i == 18 || i == 23) {
			if (c != '-') return -EINVAL;
			continue;
		}
		if (c >= '0' && c <= '9') nibble = (uint8_t)(c - '0');
		else if (c >= 'a' && c <= 'f') nibble = (uint8_t)(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') nibble = (uint8_t)(c - 'A' + 10);
		else return -EINVAL;
		halves[digits / 16] = (halves[digits / 16] << 4) | nibble;
		++digits;
	}
	*high = halves[0];
	*low = halves[1];
	return (*high || *low) ? 0 : -EINVAL;
}

void livestock_config_init(void)
{
	struct offline_saved_config loaded = {0};
	ssize_t length = settings_load_one(OFFGRID_SETTINGS_KEY, &loaded, sizeof(loaded));

	if (length == sizeof(loaded) && loaded.magic == OFFGRID_MAGIC &&
	    loaded.country[0] && loaded.country[1] && loaded.country[2] == '\0') {
		saved = loaded;
		LOG_INF("Off-grid provisioning loaded device=%s country=%s",
			saved.device_id, saved.country);
	} else {
		LOG_INF("Off-grid provisioning not found rc=%d", (int)length);
	}
}

const char *livestock_config_country(void)
{
	return saved.country;
}

bool livestock_config_is_provisioned(void)
{
	return saved.magic == OFFGRID_MAGIC;
}

int livestock_config_apply_json(char *json, size_t length, const char *device_serial,
				char *confirmation_id, size_t confirmation_id_size)
{
	struct provisioning_json request = {0};
	struct offline_saved_config updated = { .magic = OFFGRID_MAGIC };
	int64_t fields;
	int rc;
	bool has_location;
	uint64_t user_id_high;
	uint64_t user_id_low;
	uint32_t resolved_frequency_khz = 0;
	uint8_t resolved_bandwidth_mhz = 0;

	if (!json || !device_serial || !confirmation_id || confirmation_id_size == 0 ||
	    length == 0 || length > 1024) {
		return -EINVAL;
	}
	confirmation_id[0] = '\0';
	fields = json_obj_parse(json, length, provisioning_descr,
				ARRAY_SIZE(provisioning_descr), &request);
	const int64_t required_fields = BIT(0) | BIT(1) | BIT(2) | BIT(3) | BIT(4) | BIT(5);
	if (fields < 0 || (fields & required_fields) != required_fields) {
		LOG_ERR("Off-grid provisioning JSON parse failed fields=%lld required=0x%llx",
			(long long)fields, (unsigned long long)required_fields);
		return -EBADMSG;
	}
	if (request.confirmation_id) {
		if (!valid_string(request.confirmation_id, confirmation_id_size)) return -EINVAL;
		strcpy(confirmation_id, request.confirmation_id);
	}
	if (!valid_string(request.client_id, sizeof(updated.device_id)) ||
	    !valid_string(request.mesh_id, 33) ||
	    !request.passphrase ||
	    !((request.passphrase[0] == '\0') ||
	      (strlen(request.passphrase) >= 8 && strlen(request.passphrase) < 65)) ||
	    (request.device_name && !valid_string(request.device_name, 65)) ||
	    !request.country || strlen(request.country) != 2 ||
	    request.halow_channel < 1 || request.halow_frequency_khz < 800000 ||
	    request.halow_frequency_khz > 1000000) {
		return -EINVAL;
	}
	if (parse_device_uuid(request.client_id, &user_id_high, &user_id_low) != 0) {
		return -EINVAL;
	}
	if (!edgez_rf_resolve_s1g_channel(request.country,
					     (uint8_t)request.halow_channel,
					     &resolved_frequency_khz,
					     &resolved_bandwidth_mhz) ||
	    resolved_frequency_khz != (uint32_t)request.halow_frequency_khz) {
		LOG_ERR("HaLow channel does not match regulatory domain country=%s channel=%d supplied=%d kHz resolved=%u kHz",
			request.country, request.halow_channel,
			request.halow_frequency_khz, resolved_frequency_khz);
		return -EINVAL;
	}
	has_location = (fields & BIT(6)) && (fields & BIT(7));
	if (request.use_device_gps && has_location) return -EINVAL;
	if (has_location && (!isfinite(request.latitude) || !isfinite(request.longitude) ||
	    request.latitude < -90 || request.latitude > 90 ||
	    request.longitude < -180 || request.longitude > 180)) {
		return -EINVAL;
	}
	strcpy(updated.country, request.country);
	strcpy(updated.device_id, request.client_id);
	rc = settings_save_one(OFFGRID_SETTINGS_KEY, &updated, sizeof(updated));
	if (rc != 0) {
		LOG_ERR("Could not save off-grid device configuration rc=%d", rc);
		return rc;
	}
	{
		struct offline_saved_config verified = {0};
		ssize_t bytes = settings_load_one(OFFGRID_SETTINGS_KEY, &verified,
						 sizeof(verified));

		if (bytes != sizeof(verified) || memcmp(&verified, &updated, sizeof(updated)) != 0) {
			LOG_ERR("Off-grid configuration NVS verification failed bytes=%d expected=%u",
				(int)bytes, (unsigned int)sizeof(verified));
			(void)settings_delete(OFFGRID_SETTINGS_KEY);
			return -EIO;
		}
	}
	rc = edgez_config_apply_provisioning(request.mesh_id, request.passphrase,
				     resolved_frequency_khz,
				     resolved_bandwidth_mhz,
				     user_id_high, user_id_low,
				     request.device_name ? request.device_name : device_serial,
				     has_location, (float)request.latitude,
				     (float)request.longitude, request.use_device_gps);
	if (rc == 0) {
		saved = updated;
		LOG_INF("Off-grid configuration saved device=%s country=%s channel=%d frequency=%u kHz bandwidth=%u MHz",
			saved.device_id, saved.country, request.halow_channel, resolved_frequency_khz,
			resolved_bandwidth_mhz);
	} else {
		/* Never leave the completion marker behind when the HaLow profile did
		 * not persist; boot must return to provisioning in that case. */
		(void)settings_delete(OFFGRID_SETTINGS_KEY);
	}
	return rc;
}
