#include "edgez_config.h"

#include <errno.h>
#include <math.h>
#include <string.h>

#include <psa/crypto.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>

#include "nanopb/pb_decode.h"
#include "nanopb/pb_encode.h"
#include "edgez_battery.h"
#include "edgez_factory_data.h"
#include "edgez_gps.h"
#include "edgez_imu.h"
#include "edgez_mesh_relay.h"
#include "edgez_reboot.h"
#include "edgez_rf_api.h"
#include "usb_control.pb.h"

LOG_MODULE_REGISTER(edgez_config, LOG_LEVEL_INF);

#define EDGEZ_IE_ID 221
#define EDGEZ_VENDOR "EdgeZ"
#define EDGEZ_VENDOR_LEN 5
#define EDGEZ_DEFAULT_INTERVAL_SECONDS 30
#define EDGEZ_PROFILE_SETTINGS_KEY "edgez/profile/v1"
#define EDGEZ_COUNTRY_SETTINGS_KEY "edgez/country/v1"
#define EDGEZ_PROFILE_MAGIC 0x455A5031U
#define EDGEZ_PROFILE_VERSION 1U
#define EDGEZ_PROVISIONING_COMMIT_GRACE_MS 5000
#define EDGEZ_PROVISIONING_CACHE_SLOTS 5U
#define EDGEZ_PROVISIONING_PACKET_MAX 512U
#define EDGEZ_PROVISIONING_ENVELOPE_HEADER_LEN 48U
#define EDGEZ_PROVISIONING_NONCE_LEN 12U
#define EDGEZ_PROVISIONING_TAG_LEN 16U

static const uint8_t provisioning_envelope_magic[] = {0x45, 0x5a, 0x50, 0x01};
static const uint8_t conversation_label[] = "EdgeZ conversation v1";

struct edgez_persisted_profile {
	uint32_t magic;
	uint16_t version;
	uint16_t settings_len;
	uint32_t mesh_frequency_khz;
	uint32_t mesh_bandwidth_mhz;
	uint8_t settings_data[ai_edgez_halow_DeviceSettings_size];
};

struct edgez_provisioning_cache_entry {
	bool valid;
	uint64_t destination;
	size_t length;
	uint8_t packet[EDGEZ_PROVISIONING_PACKET_MAX];
};

K_MUTEX_DEFINE(config_lock);
K_MUTEX_DEFINE(provisioning_cache_lock);
static struct edgez_provisioning_cache_entry provisioning_cache[EDGEZ_PROVISIONING_CACHE_SLOTS];
static size_t provisioning_cache_next;
static ai_edgez_halow_DeviceSettings settings;
static char factory_serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
static uint32_t mesh_frequency_khz;
static uint32_t mesh_bandwidth_mhz;
static char country_code[3];
static uint32_t config_generation = 1;
static bool halow_initialized;
static bool halow_link_up;
static uint8_t halow_mac[6];
static int64_t runtime_start_not_before_ms;
static atomic_t halow_beacon_build_count;
static atomic_t halow_beacon_last_ies_len;
static uint8_t beacon_vendor_ies[EDGEZ_VENDOR_IES_MAX_LEN];
static size_t beacon_vendor_ies_len;
volatile uint32_t edgez_config_provisioning_stage;
volatile int32_t edgez_config_provisioning_last_rc;
volatile int32_t edgez_config_provisioning_psa_status;
volatile uint64_t edgez_config_provisioning_outer_to;
volatile uint64_t edgez_config_provisioning_outer_from;
volatile uint64_t edgez_config_provisioning_local_node;
volatile uint32_t edgez_config_provisioning_envelope_len;
volatile int32_t edgez_config_provisioning_factory_rc;

static uint64_t mac_to_node_id(const uint8_t mac[6]);
static struct k_spinlock beacon_vendor_ies_lock;

static bool provisioning_envelope(const ai_edgez_halow_NetworkPacket *packet)
{
	return packet && packet->which_body == ai_edgez_halow_NetworkPacket_msg_tag &&
		packet->operation == ai_edgez_halow_Operation_REQUEST &&
		packet->body.msg.mime == ai_edgez_halow_Mime_MIME_BINARY &&
		packet->body.msg.payload.size >=
			EDGEZ_PROVISIONING_ENVELOPE_HEADER_LEN + EDGEZ_PROVISIONING_TAG_LEN &&
		memcmp(packet->body.msg.payload.bytes, provisioning_envelope_magic,
		       sizeof(provisioning_envelope_magic)) == 0;
}

static void put_le64(uint8_t output[8], uint64_t value)
{
	for (size_t index = 0; index < 8; ++index) {
		output[index] = (uint8_t)(value >> (index * 8U));
	}
}

static int compare_identity(uint64_t left_node, const uint8_t left_key[32],
			    uint64_t right_node, const uint8_t right_key[32])
{
	if (left_node < right_node) return -1;
	if (left_node > right_node) return 1;
	return memcmp(left_key, right_key, 32);
}

static int decrypt_provisioning_envelope(const ai_edgez_halow_NetworkPacket *outer,
					 uint8_t *plaintext, size_t plaintext_cap,
					 size_t *plaintext_len)
{
	struct edgez_factory_identity factory;
	const uint8_t *envelope = outer->body.msg.payload.bytes;
	const size_t envelope_len = outer->body.msg.payload.size;
	const uint8_t *sender_public_key = envelope + sizeof(provisioning_envelope_magic);
	const uint8_t *nonce = sender_public_key + EDGEZ_FACTORY_KEY_SIZE;
	const uint8_t *ciphertext = nonce + EDGEZ_PROVISIONING_NONCE_LEN;
	const size_t ciphertext_len = envelope_len - EDGEZ_PROVISIONING_ENVELOPE_HEADER_LEN;
	uint8_t shared[32] = {0};
	uint8_t key_material[sizeof(conversation_label) - 1U + 32U + 40U + 40U];
	uint8_t sender_identity[40];
	uint8_t recipient_identity[40];
	uint8_t aes_key[32] = {0};
	uint8_t aad[18U + EDGEZ_PROVISIONING_NONCE_LEN];
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t key_id = 0;
	psa_status_t status;
	size_t shared_len = 0;
	size_t offset = 0;
	int rc = -EACCES;
	int factory_rc = edgez_factory_data_get(&factory);

	edgez_config_provisioning_stage = 10U;
	edgez_config_provisioning_outer_from = outer->from;
	edgez_config_provisioning_envelope_len = envelope_len;
	edgez_config_provisioning_factory_rc = factory_rc;
	if (!plaintext || !plaintext_len || ciphertext_len <= EDGEZ_PROVISIONING_TAG_LEN ||
	    outer->from == 0 || outer->to == 0 || factory_rc != 0) {
		edgez_config_provisioning_stage = 11U;
		return -EINVAL;
	}
	status = psa_crypto_init();
	edgez_config_provisioning_psa_status = status;
	if (status != PSA_SUCCESS) goto cleanup;
	edgez_config_provisioning_stage = 12U;
	psa_set_key_type(&attributes,
		PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY));
	psa_set_key_bits(&attributes, 255);
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&attributes, PSA_ALG_ECDH);
	status = psa_import_key(&attributes, factory.private_key,
				sizeof(factory.private_key), &key_id);
	edgez_config_provisioning_psa_status = status;
	psa_reset_key_attributes(&attributes);
	if (status != PSA_SUCCESS) goto cleanup;
	edgez_config_provisioning_stage = 13U;
	status = psa_raw_key_agreement(PSA_ALG_ECDH, key_id, sender_public_key, 32,
				       shared, sizeof(shared), &shared_len);
	edgez_config_provisioning_psa_status = status;
	(void)psa_destroy_key(key_id);
	key_id = 0;
	if (status != PSA_SUCCESS || shared_len != sizeof(shared)) goto cleanup;
	edgez_config_provisioning_stage = 14U;

	put_le64(sender_identity, outer->from);
	memcpy(sender_identity + 8, sender_public_key, 32);
	put_le64(recipient_identity, outer->to);
	memcpy(recipient_identity + 8, factory.public_key, 32);
	memcpy(key_material + offset, conversation_label, sizeof(conversation_label) - 1U);
	offset += sizeof(conversation_label) - 1U;
	memcpy(key_material + offset, shared, sizeof(shared));
	offset += sizeof(shared);
	if (compare_identity(outer->from, sender_public_key,
			     outer->to, factory.public_key) <= 0) {
		memcpy(key_material + offset, sender_identity, sizeof(sender_identity));
		offset += sizeof(sender_identity);
		memcpy(key_material + offset, recipient_identity, sizeof(recipient_identity));
	} else {
		memcpy(key_material + offset, recipient_identity, sizeof(recipient_identity));
		offset += sizeof(recipient_identity);
		memcpy(key_material + offset, sender_identity, sizeof(sender_identity));
	}
	status = psa_hash_compute(PSA_ALG_SHA_256, key_material, sizeof(key_material),
				  aes_key, sizeof(aes_key), &offset);
	edgez_config_provisioning_psa_status = status;
	if (status != PSA_SUCCESS || offset != sizeof(aes_key)) goto cleanup;
	edgez_config_provisioning_stage = 15U;
	put_le64(aad, outer->from);
	put_le64(aad + 8, outer->to);
	aad[16] = EDGEZ_PROVISIONING_NONCE_LEN;
	aad[17] = 0;
	memcpy(aad + 18, nonce, EDGEZ_PROVISIONING_NONCE_LEN);

	psa_set_key_type(&attributes, PSA_KEY_TYPE_AES);
	psa_set_key_bits(&attributes, 256);
	psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_DECRYPT);
	psa_set_key_algorithm(&attributes, PSA_ALG_GCM);
	status = psa_import_key(&attributes, aes_key, sizeof(aes_key), &key_id);
	edgez_config_provisioning_psa_status = status;
	psa_reset_key_attributes(&attributes);
	if (status != PSA_SUCCESS) goto cleanup;
	edgez_config_provisioning_stage = 16U;
	status = psa_aead_decrypt(key_id, PSA_ALG_GCM, nonce,
				  EDGEZ_PROVISIONING_NONCE_LEN, aad, sizeof(aad),
				  ciphertext, ciphertext_len, plaintext, plaintext_cap,
				  plaintext_len);
	edgez_config_provisioning_psa_status = status;
	if (status == PSA_SUCCESS) {
		rc = 0;
		edgez_config_provisioning_stage = 17U;
	}

cleanup:
	if (key_id != 0) (void)psa_destroy_key(key_id);
	memset(&factory, 0, sizeof(factory));
	memset(shared, 0, sizeof(shared));
	memset(key_material, 0, sizeof(key_material));
	memset(aes_key, 0, sizeof(aes_key));
	return rc;
}

static int cache_provisioning_response(uint64_t destination,
				       const uint8_t *packet, size_t packet_len)
{
	if (destination == 0 || !packet || packet_len == 0 ||
	    packet_len > EDGEZ_PROVISIONING_PACKET_MAX) {
		return -EINVAL;
	}
	k_mutex_lock(&provisioning_cache_lock, K_FOREVER);
	struct edgez_provisioning_cache_entry *entry = NULL;
	bool replaced = false;
	for (size_t i = 0; i < ARRAY_SIZE(provisioning_cache); ++i) {
		if (provisioning_cache[i].valid &&
		    provisioning_cache[i].destination == destination) {
			entry = &provisioning_cache[i];
			replaced = true;
			break;
		}
	}
	if (!entry) {
		entry = &provisioning_cache[provisioning_cache_next];
		provisioning_cache_next =
			(provisioning_cache_next + 1U) % ARRAY_SIZE(provisioning_cache);
	}
	entry->valid = true;
	entry->destination = destination;
	entry->length = packet_len;
	memcpy(entry->packet, packet, packet_len);
	k_mutex_unlock(&provisioning_cache_lock);
	LOG_INF("%s zero-touch response for node=%012llx bytes=%u slots=%u",
		replaced ? "Replaced" : "Cached",
		(unsigned long long)destination, (unsigned int)packet_len,
		(unsigned int)ARRAY_SIZE(provisioning_cache));
	return 0;
}

void edgez_config_forget_provisioning_response(const uint8_t destination[6])
{
	if (!destination) return;
	const uint64_t node = mac_to_node_id(destination);
	bool removed = false;
	k_mutex_lock(&provisioning_cache_lock, K_FOREVER);
	for (size_t i = 0; i < ARRAY_SIZE(provisioning_cache); ++i) {
		if (provisioning_cache[i].valid &&
		    provisioning_cache[i].destination == node) {
			memset(&provisioning_cache[i], 0, sizeof(provisioning_cache[i]));
			removed = true;
			break;
		}
	}
	k_mutex_unlock(&provisioning_cache_lock);
	if (removed) {
		LOG_INF("Removed accepted zero-touch response for node=%012llx",
			(unsigned long long)node);
	}
}

int edgez_config_replay_provisioning_response(const uint8_t destination[6])
{
	uint8_t packet[EDGEZ_PROVISIONING_PACKET_MAX];
	size_t packet_len = 0;
	uint64_t node;

	if (!destination) return -EINVAL;
	node = mac_to_node_id(destination);
	k_mutex_lock(&provisioning_cache_lock, K_FOREVER);
	for (size_t i = 0; i < ARRAY_SIZE(provisioning_cache); ++i) {
		if (provisioning_cache[i].valid &&
		    provisioning_cache[i].destination == node) {
			packet_len = provisioning_cache[i].length;
			memcpy(packet, provisioning_cache[i].packet, packet_len);
			break;
		}
	}
	k_mutex_unlock(&provisioning_cache_lock);
	if (packet_len == 0) return -ENOENT;
	int rc = edgez_nrf_relay_send(destination, packet, packet_len);
	if (rc == 0) {
		LOG_INF("Replayed zero-touch response to node=%012llx bytes=%u",
			(unsigned long long)node, (unsigned int)packet_len);
	}
	return rc;
}

/*
 * Called by the Morse mesh beacon builder. This must stay non-blocking because
 * it runs on the radio's management-frame path; IMU sampling is performed by
 * the application thread before publishing a new cached payload here.
 */
size_t mmwlan_mesh_beacon_dynamic_ies(uint8_t *out, size_t out_cap)
{
	size_t len;
	k_spinlock_key_t key;

	if (!out || out_cap == 0) {
		return 0;
	}

	/* Reaching this callback means the Morse management-frame path is building
	 * a real mesh beacon. Only record the milestone here; never touch I2C from
	 * the radio driver thread. */
	edgez_imu_note_halow_tx();
	atomic_inc(&halow_beacon_build_count);

	key = k_spin_lock(&beacon_vendor_ies_lock);
	len = beacon_vendor_ies_len;
	if (len > out_cap) {
		len = 0;
	} else if (len > 0) {
		memcpy(out, beacon_vendor_ies, len);
	}
	k_spin_unlock(&beacon_vendor_ies_lock, key);
	atomic_set(&halow_beacon_last_ies_len, (atomic_val_t)len);
	return len;
}

static bool persistent_device_mode(ai_edgez_halow_DeviceType device_type)
{
	/* A provisioned USER needs the same radio profile after reboot. Persisting
	 * only appliance modes made HaLowInitConfig start the radio with a volatile
	 * USER profile, racing the follow-up DeviceSettings SET over BLE. */
	return device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_USER ||
	       device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_BEACON ||
	       device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR ||
	       device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_RELAY;
}

/* config_lock must be held by the caller. Never log passphrases or key data. */
static void log_profile_readiness_locked(const char *context)
{
	bool mode_ok = persistent_device_mode(settings.device_type);
	bool mesh_ok = settings.mesh_id[0] != '\0';
	bool frequency_ok = mesh_frequency_khz > 0;
	bool bandwidth_ok = mesh_bandwidth_mhz > 0;

	LOG_INF("HaLow profile check context=%s ready=%u mode_ok=%u mesh_ok=%u frequency_ok=%u bandwidth_ok=%u device_type=%d mesh_id=\"%s\" passphrase_len=%u frequency=%u kHz bandwidth=%u MHz generation=%u",
		context, mode_ok && mesh_ok && frequency_ok && bandwidth_ok,
		mode_ok, mesh_ok, frequency_ok, bandwidth_ok, settings.device_type,
		settings.mesh_id, (unsigned int)strlen(settings.passphrase),
		mesh_frequency_khz, mesh_bandwidth_mhz, config_generation);
	if (mode_ok && (!frequency_ok || !bandwidth_ok)) {
		LOG_WRN("HaLow profile incomplete after %s: radio frequency/bandwidth are zero or were not provided",
			context);
	}
}

static void copy_string(char *dst, size_t dst_size, const char *src)
{
	if (!dst || dst_size == 0) {
		return;
	}
	strncpy(dst, src ? src : "", dst_size - 1);
	dst[dst_size - 1] = '\0';
}

static ai_edgez_halow_MarkerColor marker_from_string(const char *marker)
{
	static const char *const names[] = {
		"default", "red", "blue", "purple", "yellow", "pink", "brown",
		"green", "orange", "deep_purple", "light_blue", "cyan", "teal",
		"lime", "deep_orange", "gray", "blue_gray",
	};

	if (!marker) return ai_edgez_halow_MarkerColor_MARKER_DEFAULT;
	for (size_t index = 0; index < ARRAY_SIZE(names); ++index) {
		if (strcmp(marker, names[index]) == 0) {
			return (ai_edgez_halow_MarkerColor)index;
		}
	}
	return ai_edgez_halow_MarkerColor_MARKER_DEFAULT;
}

static void normalize_settings(ai_edgez_halow_DeviceSettings *value)
{
	if (value->beacon_interval_seconds < 5 || value->beacon_interval_seconds > 3600) {
		value->beacon_interval_seconds = EDGEZ_DEFAULT_INTERVAL_SECONDS;
	}
	if (value->max_hop == 0 || value->max_hop > UINT8_MAX) {
		value->max_hop = 2;
	}
	if (value->user_name[0] == '\0' ||
	    (value->device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR &&
	     strcmp(value->user_name, "EdgeZ User") == 0)) {
		copy_string(value->user_name, sizeof(value->user_name),
			factory_serial[0] != '\0' ? factory_serial : "EdgeZ User");
	}
	if (value->device_type < ai_edgez_halow_DeviceType_DEVICE_TYPE_USER ||
	    value->device_type > ai_edgez_halow_DeviceType_DEVICE_TYPE_RELAY) {
		value->device_type = value->device_mode_enabled ?
			ai_edgez_halow_DeviceType_DEVICE_TYPE_BEACON :
			ai_edgez_halow_DeviceType_DEVICE_TYPE_USER;
	}
	if (value->icon_style[0] == '\0') {
		copy_string(value->icon_style, sizeof(value->icon_style),
			value->device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR ?
			"sensor" : "person");
	}

	/* BEACON and SENSOR are battery-powered request clients.  Treat the role as
	 * authoritative so profiles written by older provisioners (which left the
	 * sleep flag at its protobuf default) still enter the HaLow wake/request/
	 * response/sleep cycle. */
	if (value->device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_BEACON ||
	    value->device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR) {
		value->sleep_mode_enabled = true;
	}
}

/* config_lock must be held by the caller. */
static int save_persisted_profile_locked(void)
{
	struct edgez_persisted_profile stored = {
		.magic = EDGEZ_PROFILE_MAGIC,
		.version = EDGEZ_PROFILE_VERSION,
		.mesh_frequency_khz = mesh_frequency_khz,
		.mesh_bandwidth_mhz = mesh_bandwidth_mhz,
	};
	pb_ostream_t output;
	int rc;

	if (!persistent_device_mode(settings.device_type)) {
		LOG_INF("Persistent HaLow save not required device_type=%d (unsupported/non-persistent mode)",
			settings.device_type);
		rc = settings_delete(EDGEZ_PROFILE_SETTINGS_KEY);
		if (rc == 0 || rc == -ENOENT) {
			LOG_INF("Persistent HaLow profile cleared for non-persistent mode");
			return 0;
		}
		LOG_WRN("Persistent HaLow profile delete failed key=%s rc=%d",
			EDGEZ_PROFILE_SETTINGS_KEY, rc);
		return rc;
	}
	if (mesh_frequency_khz == 0 || mesh_bandwidth_mhz == 0) {
		LOG_ERR("Persistent HaLow profile not saved: missing radio config frequency=%u kHz bandwidth=%u MHz device_type=%d mesh_id=\"%s\"",
			mesh_frequency_khz, mesh_bandwidth_mhz, settings.device_type,
			settings.mesh_id);
		return -EAGAIN;
	}
	settings.mesh_frequency_khz = mesh_frequency_khz;
	settings.mesh_bandwidth_mhz = mesh_bandwidth_mhz;

	output = pb_ostream_from_buffer(stored.settings_data,
					 sizeof(stored.settings_data));
	if (!pb_encode(&output, ai_edgez_halow_DeviceSettings_fields, &settings)) {
		LOG_WRN("Persistent DeviceSettings encode failed: %s", PB_GET_ERROR(&output));
		return -EMSGSIZE;
	}
	stored.settings_len = (uint16_t)output.bytes_written;
	rc = settings_save_one(EDGEZ_PROFILE_SETTINGS_KEY, &stored,
			       offsetof(struct edgez_persisted_profile, settings_data) +
			       stored.settings_len);
	if (rc == 0) {
		struct edgez_persisted_profile verified = {0};
		size_t stored_len = offsetof(struct edgez_persisted_profile, settings_data) +
			stored.settings_len;
		ssize_t verified_len = settings_load_one(EDGEZ_PROFILE_SETTINGS_KEY, &verified,
						       sizeof(verified));

		if (verified_len != stored_len || memcmp(&verified, &stored, stored_len) != 0) {
			LOG_ERR("Persistent HaLow profile NVS verification failed bytes=%d expected=%u",
				(int)verified_len, (unsigned int)stored_len);
			return -EIO;
		}
		LOG_INF("Persistent HaLow profile saved device_type=%d mesh_id=%s frequency=%u kHz bandwidth=%u MHz bytes=%u",
			settings.device_type, settings.mesh_id, mesh_frequency_khz,
			mesh_bandwidth_mhz, stored.settings_len);
			edgez_request_reboot(EDGEZ_REBOOT_REASON_SETTINGS_SAVED);
		if (settings_save_one(EDGEZ_COUNTRY_SETTINGS_KEY, country_code,
				      sizeof(country_code)) != 0) {
			LOG_WRN("Persistent country save failed country=%s", country_code);
		}
	} else {
		LOG_ERR("Persistent HaLow profile settings write failed key=%s bytes=%u rc=%d",
			EDGEZ_PROFILE_SETTINGS_KEY,
			(unsigned int)(offsetof(struct edgez_persisted_profile, settings_data) +
				       stored.settings_len), rc);
	}
	return rc;
}

/* config_lock must be held by the caller. */
static int load_persisted_profile_locked(void)
{
	struct edgez_persisted_profile stored = {0};
	ai_edgez_halow_DeviceSettings loaded = ai_edgez_halow_DeviceSettings_init_zero;
	pb_istream_t input;
	ssize_t bytes;
	size_t header_len = offsetof(struct edgez_persisted_profile, settings_data);

	bytes = settings_load_one(EDGEZ_PROFILE_SETTINGS_KEY, &stored, sizeof(stored));
	if (bytes < 0) {
		LOG_INF("Persistent HaLow profile read key=%s rc=%d",
			EDGEZ_PROFILE_SETTINGS_KEY, (int)bytes);
		return (int)bytes;
	}
	if (bytes == 0) {
		LOG_INF("Persistent HaLow profile key=%s is empty; treating as absent",
			EDGEZ_PROFILE_SETTINGS_KEY);
		return -ENOENT;
	}
	LOG_INF("Persistent HaLow profile raw bytes=%d header=%u magic=0x%08x expected_magic=0x%08x version=%u expected_version=%u settings_len=%u capacity=%u frequency=%u kHz bandwidth=%u MHz",
		(int)bytes, (unsigned int)header_len, stored.magic, EDGEZ_PROFILE_MAGIC,
		stored.version, EDGEZ_PROFILE_VERSION, stored.settings_len,
		(unsigned int)sizeof(stored.settings_data), stored.mesh_frequency_khz,
		stored.mesh_bandwidth_mhz);
	if ((size_t)bytes < header_len || stored.magic != EDGEZ_PROFILE_MAGIC ||
	    stored.version != EDGEZ_PROFILE_VERSION || stored.settings_len == 0 ||
	    stored.settings_len > sizeof(stored.settings_data) ||
	    (size_t)bytes != header_len + stored.settings_len ||
	    stored.mesh_frequency_khz == 0 || stored.mesh_bandwidth_mhz == 0) {
		LOG_ERR("Persistent HaLow profile validation failed short=%u magic_bad=%u version_bad=%u settings_len_bad=%u total_len_bad=%u frequency_missing=%u bandwidth_missing=%u",
			(size_t)bytes < header_len, stored.magic != EDGEZ_PROFILE_MAGIC,
			stored.version != EDGEZ_PROFILE_VERSION,
			stored.settings_len == 0 ||
				stored.settings_len > sizeof(stored.settings_data),
			(size_t)bytes != header_len + stored.settings_len,
			stored.mesh_frequency_khz == 0, stored.mesh_bandwidth_mhz == 0);
		return -EINVAL;
	}

	input = pb_istream_from_buffer(stored.settings_data, stored.settings_len);
	if (!pb_decode(&input, ai_edgez_halow_DeviceSettings_fields, &loaded)) {
		LOG_WRN("Persistent DeviceSettings decode failed: %s", PB_GET_ERROR(&input));
		return -EBADMSG;
	}
	normalize_settings(&loaded);
	if (!persistent_device_mode(loaded.device_type)) {
		LOG_ERR("Persistent HaLow profile decoded but device_type=%d is not user/beacon/sensor/relay",
			loaded.device_type);
		return -EINVAL;
	}

	settings = loaded;
	settings.action = ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
	mesh_frequency_khz = stored.mesh_frequency_khz;
	mesh_bandwidth_mhz = stored.mesh_bandwidth_mhz;
	settings.mesh_frequency_khz = mesh_frequency_khz;
	settings.mesh_bandwidth_mhz = mesh_bandwidth_mhz;
	char loaded_country[3] = {0};
	ssize_t country_len = settings_load_one(EDGEZ_COUNTRY_SETTINGS_KEY,
						loaded_country, sizeof(loaded_country));
	if (country_len == sizeof(loaded_country) && loaded_country[0] &&
	    loaded_country[1] && loaded_country[2] == '\0') {
		memcpy(country_code, loaded_country, sizeof(country_code));
	}
	LOG_INF("Persistent HaLow profile loaded device_type=%d mesh_id=%s frequency=%u kHz bandwidth=%u MHz",
		settings.device_type, settings.mesh_id, mesh_frequency_khz,
		mesh_bandwidth_mhz);
	return 0;
}

void edgez_config_init(const char *mesh_id, const char *passphrase)
{
	struct edgez_factory_identity factory_identity = {0};
	bool have_factory_identity =
		edgez_factory_data_get(&factory_identity) == 0;
	uint32_t factory_frequency_khz = 0;
	uint8_t factory_bandwidth_mhz = 0;
	bool have_factory_profile = have_factory_identity &&
		factory_identity.has_halow_profile &&
		edgez_rf_resolve_s1g_channel(factory_identity.country,
			factory_identity.channel, &factory_frequency_khz,
			&factory_bandwidth_mhz);
	int settings_rc;
	int load_rc;

	if (have_factory_identity && factory_identity.has_halow_profile &&
	    !have_factory_profile) {
		LOG_ERR("Factory HaLow profile rejected country=%s channel=%u",
			factory_identity.country, factory_identity.channel);
	}

	settings_rc = settings_subsys_init();
	LOG_INF("Persistent HaLow settings subsystem init rc=%d", settings_rc);
	if (settings_rc != 0 && settings_rc != -EALREADY) {
		LOG_WRN("Persistent HaLow settings init failed: %d", settings_rc);
	}
	k_mutex_lock(&config_lock, K_FOREVER);
	copy_string(factory_serial, sizeof(factory_serial),
		have_factory_identity ? factory_identity.serial : "");
	settings = (ai_edgez_halow_DeviceSettings)ai_edgez_halow_DeviceSettings_init_zero;
	settings.action = ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
	copy_string(settings.mesh_id, sizeof(settings.mesh_id), mesh_id);
	copy_string(settings.passphrase, sizeof(settings.passphrase), passphrase);
	copy_string(settings.user_name, sizeof(settings.user_name),
		have_factory_identity ? factory_identity.serial : "EdgeZ User");
	if (have_factory_identity) {
		memcpy(&settings.user_id_high, factory_identity.public_key,
		       sizeof(settings.user_id_high));
		memcpy(&settings.user_id_low, factory_identity.public_key + 8,
		       sizeof(settings.user_id_low));
		settings.user_public_key.size = EDGEZ_FACTORY_KEY_SIZE;
		memcpy(settings.user_public_key.bytes, factory_identity.public_key,
		       EDGEZ_FACTORY_KEY_SIZE);
	}
	settings.user_private_key.size = have_factory_identity ? 32 : 0;
	if (have_factory_identity) {
		memcpy(settings.user_private_key.bytes, factory_identity.private_key, 32);
	}
	settings.device_type = IS_ENABLED(CONFIG_OFFGRID_NRF54_ROLE_SENSOR) ?
		ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR :
		ai_edgez_halow_DeviceType_DEVICE_TYPE_USER;
	settings.sleep_mode_enabled = IS_ENABLED(CONFIG_OFFGRID_NRF54_ROLE_SENSOR);
	settings.beacon_interval_seconds = EDGEZ_DEFAULT_INTERVAL_SECONDS;
	settings.max_hop = 2;
	copy_string(country_code, sizeof(country_code), CONFIG_WIFI_MORSEMICRO_REGION);
	if (have_factory_identity) {
		copy_string(country_code, sizeof(country_code), factory_identity.country);
	}
	mesh_frequency_khz = 0;
	mesh_bandwidth_mhz = 0;
	halow_initialized = false;
	halow_link_up = false;
	memset(halow_mac, 0, sizeof(halow_mac));
	config_generation = 1;
	runtime_start_not_before_ms = 0;
	atomic_set(&halow_beacon_build_count, 0);
	atomic_set(&halow_beacon_last_ies_len, 0);
	if (settings_rc == 0 || settings_rc == -EALREADY) {
		load_rc = load_persisted_profile_locked();
		if (load_rc != 0 && load_rc != -ENOENT) {
			LOG_WRN("Persistent HaLow profile ignored: %d", load_rc);
		} else if (load_rc == -ENOENT && !have_factory_profile) {
		#if defined(CONFIG_OFFGRID_NRF54_ROLE_SENSOR)
			LOG_INF("Persistent HaLow profile absent; zero-touch HaLow provisioning is required");
		#else
			LOG_INF("Persistent HaLow profile absent; BLE provisioning is required");
		#endif
		}
	}
	if (have_factory_profile) {
		copy_string(country_code, sizeof(country_code), factory_identity.country);
		copy_string(settings.mesh_id, sizeof(settings.mesh_id),
			factory_identity.mesh_id);
		copy_string(settings.passphrase, sizeof(settings.passphrase),
			factory_identity.passphrase);
		settings.device_type = ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR;
		settings.sleep_mode_enabled = true;
		mesh_frequency_khz = factory_frequency_khz;
		mesh_bandwidth_mhz = factory_bandwidth_mhz;
		settings.mesh_frequency_khz = factory_frequency_khz;
		settings.mesh_bandwidth_mhz = factory_bandwidth_mhz;
		LOG_INF("Using factory HaLow profile country=%s mesh_id=%s channel=%u frequency=%u kHz bandwidth=%u MHz; discovery skipped",
			country_code, settings.mesh_id, factory_identity.channel,
			mesh_frequency_khz, mesh_bandwidth_mhz);
	}
	memset(&factory_identity, 0, sizeof(factory_identity));
	log_profile_readiness_locked("boot");
	k_mutex_unlock(&config_lock);
}

void edgez_config_get_profile(struct edgez_halow_profile *profile)
{
	if (!profile) {
		return;
	}
	k_mutex_lock(&config_lock, K_FOREVER);
	copy_string(profile->country_code, sizeof(profile->country_code), country_code);
	copy_string(profile->mesh_id, sizeof(profile->mesh_id), settings.mesh_id);
	copy_string(profile->passphrase, sizeof(profile->passphrase), settings.passphrase);
	profile->mesh_frequency_khz = mesh_frequency_khz;
	profile->mesh_bandwidth_mhz = mesh_bandwidth_mhz;
	profile->beacon_interval_seconds = settings.beacon_interval_seconds;
	profile->device_type = (uint32_t)settings.device_type;
	profile->sleep_mode_enabled = settings.sleep_mode_enabled;
	profile->device_gps_enabled = settings.device_gps_enabled;
	k_mutex_unlock(&config_lock);
}

int edgez_config_apply_provisioning(const char *mesh_id, const char *passphrase,
				   uint32_t frequency_khz,
				   uint32_t bandwidth_mhz,
				   uint64_t user_id_high,
				   uint64_t user_id_low, const char *user_name,
				   bool has_location, float latitude, float longitude,
				   bool use_device_gps)
{
	int rc;

	if (!mesh_id || !passphrase || !user_name || !user_name[0] ||
	    strlen(mesh_id) >= sizeof(settings.mesh_id) ||
	    strlen(passphrase) >= sizeof(settings.passphrase) ||
	    strlen(user_name) >= sizeof(settings.user_name) ||
	    (user_id_high == 0 && user_id_low == 0) || frequency_khz == 0 ||
	    bandwidth_mhz == 0) {
		return -EINVAL;
	}
	k_mutex_lock(&config_lock, K_FOREVER);
	copy_string(settings.mesh_id, sizeof(settings.mesh_id), mesh_id);
	copy_string(settings.passphrase, sizeof(settings.passphrase), passphrase);
	settings.user_id_high = user_id_high;
	settings.user_id_low = user_id_low;
	copy_string(settings.user_name, sizeof(settings.user_name), user_name);
	settings.device_type = ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR;
	settings.device_gps_enabled = use_device_gps;
	settings.share_location = has_location;
	settings.latitude = has_location ? latitude : 0;
	settings.longitude = has_location ? longitude : 0;
	mesh_frequency_khz = frequency_khz;
	mesh_bandwidth_mhz = bandwidth_mhz;
	settings.mesh_frequency_khz = frequency_khz;
	settings.mesh_bandwidth_mhz = bandwidth_mhz;
	normalize_settings(&settings);
	config_generation++;
	rc = save_persisted_profile_locked();
	if (rc == 0) {
		runtime_start_not_before_ms = 0;
	}
	k_mutex_unlock(&config_lock);
	return rc;
}

uint32_t edgez_config_generation(void)
{
	uint32_t generation;
	k_mutex_lock(&config_lock, K_FOREVER);
	generation = config_generation;
	k_mutex_unlock(&config_lock);
	return generation;
}

void edgez_config_set_halow_ready(bool ready)
{
	k_mutex_lock(&config_lock, K_FOREVER);
	halow_initialized = ready;
	halow_link_up = ready;
	k_mutex_unlock(&config_lock);
}

void edgez_config_set_halow_link(bool link_up)
{
	k_mutex_lock(&config_lock, K_FOREVER);
	halow_link_up = halow_initialized && link_up;
	k_mutex_unlock(&config_lock);
}

void edgez_config_set_halow_mac(const uint8_t mac[6])
{
	if (!mac) return;
	k_mutex_lock(&config_lock, K_FOREVER);
	memcpy(halow_mac, mac, sizeof(halow_mac));
	k_mutex_unlock(&config_lock);
}

bool edgez_config_halow_beacon_started(void)
{
	return atomic_get(&halow_beacon_build_count) > 0;
}

uint32_t edgez_config_halow_beacon_build_count(void)
{
	return (uint32_t)atomic_get(&halow_beacon_build_count);
}

size_t edgez_config_halow_beacon_last_ies_len(void)
{
	return (size_t)atomic_get(&halow_beacon_last_ies_len);
}

bool edgez_config_should_autostart(void)
{
	bool ready;

	k_mutex_lock(&config_lock, K_FOREVER);
	ready = persistent_device_mode(settings.device_type) &&
		settings.mesh_id[0] != '\0' &&
		mesh_frequency_khz > 0 && mesh_bandwidth_mhz > 0;
	k_mutex_unlock(&config_lock);
	return ready;
}

bool edgez_config_is_complete(void)
{
	bool ready;
	int64_t now = k_uptime_get();

	k_mutex_lock(&config_lock, K_FOREVER);
	ready = settings.mesh_id[0] != '\0' &&
		mesh_frequency_khz > 0 && mesh_bandwidth_mhz > 0 &&
		now >= runtime_start_not_before_ms;
	k_mutex_unlock(&config_lock);
	return ready;
}

static void response_base(const ai_edgez_halow_NetworkPacket *request,
			  ai_edgez_halow_NetworkPacket *response)
{
	response->from = request->to;
	response->to = request->from;
	response->operation = ai_edgez_halow_Operation_RESPONSE;
	response->interface = ai_edgez_halow_Interface_HALOW;
}

static void fill_status_locked(ai_edgez_halow_HaLowInterfaceStatus *status)
{
	status->supported = true;
	status->stack_initialized = halow_initialized;
	status->mesh_mode = true;
	status->link_up = halow_link_up;
	status->route_ready = halow_link_up;
	status->ready_for_report = halow_link_up;
	status->ethertype = 0x88B5;
	copy_string(status->mesh_id, sizeof(status->mesh_id), settings.mesh_id);
	status->mac_address = mac_to_node_id(halow_mac);
	/* nRF54 delegates license enforcement to the mobile client. */
	status->license_status =
		ai_edgez_halow_LicenseStatus_LICENSE_STATUS_AUTHORIZED;
}

static int handle_packet_internal(const uint8_t *payload, size_t payload_len,
				  uint8_t *response_buf, size_t response_cap,
				  size_t *response_len, bool encrypted_profile)
{
	ai_edgez_halow_NetworkPacket request = ai_edgez_halow_NetworkPacket_init_zero;
	ai_edgez_halow_NetworkPacket response = ai_edgez_halow_NetworkPacket_init_zero;
	pb_istream_t input;
	pb_ostream_t output;

	if (!payload || !response_buf || !response_len) {
		return -EINVAL;
	}
	*response_len = 0;
	input = pb_istream_from_buffer(payload, payload_len);
	if (!pb_decode(&input, ai_edgez_halow_NetworkPacket_fields, &request)) {
		edgez_config_provisioning_stage = 1U;
		edgez_config_provisioning_last_rc = -EBADMSG;
		LOG_WRN("BLE NetworkPacket decode failed: %s", PB_GET_ERROR(&input));
		return -EBADMSG;
	}
	LOG_INF("BLE NetworkPacket request body=%u operation=%u len=%u",
		request.which_body, request.operation, (unsigned int)payload_len);
	response_base(&request, &response);
	uint64_t local_node;
	k_mutex_lock(&config_lock, K_FOREVER);
	local_node = mac_to_node_id(halow_mac);
	k_mutex_unlock(&config_lock);
	edgez_config_provisioning_outer_to = request.to;
	edgez_config_provisioning_local_node = local_node;
	if (request.to != 0 && request.to != local_node) {
		edgez_config_provisioning_stage = 2U;
		uint8_t destination[6];
		uint64_t node = request.to;

		for (int i = 5; i >= 0; --i) {
			destination[i] = (uint8_t)(node & 0xffU);
			node >>= 8;
		}
		if ((request.which_body == ai_edgez_halow_NetworkPacket_init_tag ||
		     request.which_body == ai_edgez_halow_NetworkPacket_device_settings_tag ||
		     provisioning_envelope(&request)) &&
		    request.operation == ai_edgez_halow_Operation_REQUEST) {
			int cache_rc = cache_provisioning_response(request.to, payload,
							   payload_len);
			if (cache_rc != 0) return cache_rc;
		}
		int relay_rc = edgez_nrf_relay_send(destination, payload, payload_len);
		if (relay_rc == 0) {
			LOG_INF("BLE NetworkPacket relayed to remote HaLow node=%012llx body=%u bytes=%u",
				(unsigned long long)request.to, request.which_body,
				(unsigned int)payload_len);
		}
		return relay_rc;
	}
	if (provisioning_envelope(&request)) {
		edgez_config_provisioning_stage = 3U;
		uint8_t plaintext[ai_edgez_halow_NetworkPacket_size];
		size_t plaintext_len = 0;
		int decrypt_rc = decrypt_provisioning_envelope(&request, plaintext,
						       sizeof(plaintext), &plaintext_len);

		if (decrypt_rc != 0) {
			edgez_config_provisioning_last_rc = decrypt_rc;
			LOG_WRN("Encrypted zero-touch profile rejected rc=%d", decrypt_rc);
			return decrypt_rc;
		}
		edgez_config_provisioning_stage = 18U;
		LOG_INF("Encrypted zero-touch profile authenticated bytes=%u",
			(unsigned int)plaintext_len);
		return handle_packet_internal(plaintext, plaintext_len, response_buf,
					      response_cap, response_len, true);
	}

	if (request.which_body == ai_edgez_halow_NetworkPacket_device_settings_tag) {
		k_mutex_lock(&config_lock, K_FOREVER);
		LOG_INF("BLE DeviceSettings received action=%u device_type=%d legacy_device_mode=%u mesh_id_len=%u passphrase_len=%u user_name_len=%u public_key_len=%u private_key_len=%u beacon_interval=%u max_hop=%u sleep=%u frequency=%u kHz bandwidth=%u MHz gps=%u",
			request.body.device_settings.action,
			request.body.device_settings.device_type,
			request.body.device_settings.device_mode_enabled,
			(unsigned int)strlen(request.body.device_settings.mesh_id),
			(unsigned int)strlen(request.body.device_settings.passphrase),
			(unsigned int)strlen(request.body.device_settings.user_name),
			(unsigned int)request.body.device_settings.user_public_key.size,
			(unsigned int)request.body.device_settings.user_private_key.size,
			request.body.device_settings.beacon_interval_seconds,
			request.body.device_settings.max_hop,
			request.body.device_settings.sleep_mode_enabled,
			request.body.device_settings.mesh_frequency_khz,
			request.body.device_settings.mesh_bandwidth_mhz,
			request.body.device_settings.device_gps_enabled);
		if (request.body.device_settings.action ==
		    ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_SET) {
			ai_edgez_halow_DeviceSettings updated = request.body.device_settings;
			int persist_rc;
			bool icon_only = updated.icon_style[0] != '\0' &&
				updated.mesh_id[0] == '\0' && updated.passphrase[0] == '\0' &&
				updated.user_name[0] == '\0' && updated.user_id_high == 0 &&
				updated.user_id_low == 0 && updated.user_public_key.size == 0 &&
				updated.mesh_frequency_khz == 0 &&
				updated.mesh_bandwidth_mhz == 0;

			if (icon_only) {
				copy_string(settings.icon_style, sizeof(settings.icon_style),
					    updated.icon_style);
				config_generation++;
				persist_rc = save_persisted_profile_locked();
				LOG_INF("Beacon icon style updated style=%s persist_rc=%d generation=%u",
					settings.icon_style, persist_rc, config_generation);
				response.body.device_settings = settings;
				response.body.device_settings.action =
					ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
				k_mutex_unlock(&config_lock);
				response.which_body = ai_edgez_halow_NetworkPacket_device_settings_tag;
				goto encode_response;
			}

			/* DeviceSettings is also used for partial mode/interval updates. Proto3
			 * scalar fields have no presence bit here, so omitted strings and identity
			 * fields arrive as empty/zero. Do not erase values previously supplied by
			 * the BLE HaLowInitConfig packet. */
			if (updated.mesh_id[0] == '\0' && settings.mesh_id[0] != '\0') {
				copy_string(updated.mesh_id, sizeof(updated.mesh_id),
					    settings.mesh_id);
			}
			if (updated.passphrase[0] == '\0' && settings.passphrase[0] != '\0') {
				copy_string(updated.passphrase, sizeof(updated.passphrase),
					    settings.passphrase);
			}
			if (updated.user_id_high == 0 && updated.user_id_low == 0 &&
			    (settings.user_id_high != 0 || settings.user_id_low != 0)) {
				updated.user_id_high = settings.user_id_high;
				updated.user_id_low = settings.user_id_low;
			}
			if (updated.user_name[0] == '\0' && settings.user_name[0] != '\0') {
				copy_string(updated.user_name, sizeof(updated.user_name),
					    settings.user_name);
			}
			if (updated.user_public_key.size == 0 && settings.user_public_key.size > 0) {
				updated.user_public_key = settings.user_public_key;
			}
			if (updated.mesh_frequency_khz > 0) {
				mesh_frequency_khz = updated.mesh_frequency_khz;
			} else {
				updated.mesh_frequency_khz = mesh_frequency_khz;
			}
			if (updated.mesh_bandwidth_mhz > 0) {
				mesh_bandwidth_mhz = updated.mesh_bandwidth_mhz;
			} else {
				updated.mesh_bandwidth_mhz = mesh_bandwidth_mhz;
			}
			settings = updated;
			normalize_settings(&settings);
			settings.action = ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
			config_generation++;
			persist_rc = save_persisted_profile_locked();
			if (persist_rc != 0) {
				LOG_ERR("Persistent HaLow profile update failed rc=%d%s", persist_rc,
					persist_rc == -EAGAIN ?
					" (radio frequency/bandwidth missing)" : "");
			} else {
				runtime_start_not_before_ms = 0;
				LOG_INF("BLE provisioning commit saved; HaLow startup released");
			}
			LOG_INF("BLE configuration applied mesh_id=%s device_type=%d user=%016llx-%016llx generation=%u",
				settings.mesh_id, settings.device_type,
				(unsigned long long)settings.user_id_high,
				(unsigned long long)settings.user_id_low,
				config_generation);
			log_profile_readiness_locked("DeviceSettings SET");
		}
		response.which_body = ai_edgez_halow_NetworkPacket_device_settings_tag;
		response.body.device_settings = settings;
		response.body.device_settings.action =
			ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
		k_mutex_unlock(&config_lock);
	} else if (request.which_body == ai_edgez_halow_NetworkPacket_init_tag) {
		if (encrypted_profile) {
			edgez_config_provisioning_stage = 20U;
		}
		const ai_edgez_halow_HaLowInitConfig *init = &request.body.init;
		bool has_configuration;

		k_mutex_lock(&config_lock, K_FOREVER);
		LOG_INF("BLE HaLowInitConfig received country=\"%s\" mesh_id_len=%u passphrase_len=%u user_name_len=%u public_key_len=%u max_hop=%u frequency=%u kHz bandwidth=%u MHz location=%u gps=%u",
			init->country_code, (unsigned int)strlen(init->mesh_id),
			(unsigned int)strlen(init->passphrase),
			(unsigned int)strlen(init->user_name),
			(unsigned int)init->user_public_key.size, init->max_hop,
			init->mesh_frequency_khz, init->mesh_bandwidth_mhz,
			init->has_location, init->device_gps_enabled);

		/* The mobile SDK also sends a completely empty HaLowInitConfig as its
		 * reconnect/status and license probe. It is not a provisioning command.
		 * Treating it as one erased the persisted mesh and identity immediately
		 * before returning the otherwise-authorized status response. */
		has_configuration = init->mesh_id[0] != '\0' ||
			init->passphrase[0] != '\0' || init->max_hop != 0 ||
			init->user_id_high != 0 || init->user_id_low != 0 ||
			init->user_name[0] != '\0' || init->user_public_key.size != 0 ||
			init->has_location || init->device_gps_enabled || init->icon_style[0] != '\0' ||
			init->mesh_frequency_khz != 0 ||
			init->mesh_bandwidth_mhz != 0;
#if defined(CONFIG_OFFGRID_NRF54_ROLE_SENSOR)
		if (has_configuration && !encrypted_profile) {
			k_mutex_unlock(&config_lock);
			LOG_WRN("Plaintext zero-touch HaLow profile rejected");
			return -EACCES;
		}
#endif
		if (!has_configuration) {
			LOG_INF("BLE HaLowInitConfig is an empty status/license probe; preserving persisted profile generation=%u",
				config_generation);
		} else {
			if (strlen(init->country_code) == 2U) {
				copy_string(country_code, sizeof(country_code), init->country_code);
			}
			copy_string(settings.mesh_id, sizeof(settings.mesh_id), init->mesh_id);
			copy_string(settings.passphrase, sizeof(settings.passphrase), init->passphrase);
			copy_string(settings.user_name, sizeof(settings.user_name), init->user_name);
			settings.max_hop = init->max_hop;
			settings.user_id_high = init->user_id_high;
			settings.user_id_low = init->user_id_low;
			settings.user_public_key.size = init->user_public_key.size;
			memcpy(settings.user_public_key.bytes, init->user_public_key.bytes,
			       init->user_public_key.size);
			settings.share_location = init->has_location;
			settings.device_gps_enabled = init->device_gps_enabled;
			settings.marker = marker_from_string(init->marker);
			copy_string(settings.icon_style, sizeof(settings.icon_style),
				    init->icon_style);
			settings.latitude = init->latitude;
			settings.longitude = init->longitude;
			if (init->mesh_frequency_khz > 0 && init->mesh_bandwidth_mhz > 0) {
				mesh_frequency_khz = init->mesh_frequency_khz;
				mesh_bandwidth_mhz = init->mesh_bandwidth_mhz;
				settings.mesh_frequency_khz = init->mesh_frequency_khz;
				settings.mesh_bandwidth_mhz = init->mesh_bandwidth_mhz;
			}
			normalize_settings(&settings);
			config_generation++;
			if (settings.mesh_id[0] != '\0' && mesh_frequency_khz > 0 &&
			    mesh_bandwidth_mhz > 0) {
				runtime_start_not_before_ms =
					k_uptime_get() + EDGEZ_PROVISIONING_COMMIT_GRACE_MS;
				LOG_INF("BLE HaLow startup deferred %d ms awaiting complete DeviceSettings SET",
					EDGEZ_PROVISIONING_COMMIT_GRACE_MS);
			}
			if (persistent_device_mode(settings.device_type)) {
				int persist_rc = save_persisted_profile_locked();
				if (encrypted_profile) {
					edgez_config_provisioning_last_rc = persist_rc;
					edgez_config_provisioning_stage =
						persist_rc == 0 ? 22U : 21U;
				}

				if (persist_rc != 0) {
					LOG_WRN("Persistent HaLow radio update failed: %d", persist_rc);
				}
			}
			LOG_INF("BLE HaLow radio configuration frequency=%u kHz bandwidth=%u MHz user=%016llx-%016llx generation=%u",
				 mesh_frequency_khz, mesh_bandwidth_mhz,
				 (unsigned long long)settings.user_id_high,
				 (unsigned long long)settings.user_id_low,
				 config_generation);
			log_profile_readiness_locked("HaLowInitConfig");
		}
		k_mutex_unlock(&config_lock);
		response.which_body = ai_edgez_halow_NetworkPacket_status_tag;
	} else if (request.which_body == ai_edgez_halow_NetworkPacket_msg_tag ||
		   request.which_body == ai_edgez_halow_NetworkPacket_beacon_tag ||
		   request.which_body == ai_edgez_halow_NetworkPacket_report_tag ||
		   request.which_body == ai_edgez_halow_NetworkPacket_payload_tag) {
		uint8_t destination[6];
		bool public_channel = request.to >= UINT64_C(38801) &&
			request.to <= UINT64_C(38809) &&
			((request.to - UINT64_C(38801)) % 2U) == 0U;
		bool broadcast = request.to == 0 || public_channel ||
			request.which_body == ai_edgez_halow_NetworkPacket_beacon_tag ||
			request.which_body == ai_edgez_halow_NetworkPacket_report_tag ||
			request.which_body == ai_edgez_halow_NetworkPacket_payload_tag;
		if (!broadcast) {
			uint64_t node = request.to;
			for (int i = 5; i >= 0; --i) {
				destination[i] = (uint8_t)(node & 0xffU);
				node >>= 8;
			}
		}
		int relay_rc = edgez_nrf_relay_send(broadcast ? NULL : destination,
						 payload, payload_len);
		if (relay_rc) return relay_rc;
		LOG_INF("BLE NetworkPacket relayed over BATMAN body=%u route=%s bytes=%u",
			request.which_body, broadcast ? "broadcast" : "unicast",
			(unsigned int)payload_len);
		return 0;
	} else if (request.which_body == ai_edgez_halow_NetworkPacket_status_tag ||
		   request.which_body == 0) {
		response.which_body = ai_edgez_halow_NetworkPacket_status_tag;
	} else {
		return -ENOTSUP;
	}

encode_response:
	if (response.which_body == ai_edgez_halow_NetworkPacket_status_tag) {
		k_mutex_lock(&config_lock, K_FOREVER);
		fill_status_locked(&response.body.status);
		LOG_INF("BLE status response supported=1 stack_initialized=%u link_up=%u license=%u mesh_id=\"%s\" frequency=%u kHz bandwidth=%u MHz",
			halow_initialized, halow_link_up,
			response.body.status.license_status, settings.mesh_id,
			mesh_frequency_khz, mesh_bandwidth_mhz);
		k_mutex_unlock(&config_lock);
	}

	output = pb_ostream_from_buffer(response_buf, response_cap);
	if (!pb_encode(&output, ai_edgez_halow_NetworkPacket_fields, &response)) {
		LOG_WRN("BLE NetworkPacket response encode failed: %s", PB_GET_ERROR(&output));
		return -ENOSPC;
	}
	*response_len = output.bytes_written;
	LOG_INF("BLE NetworkPacket response body=%u operation=%u len=%u",
		response.which_body, response.operation, (unsigned int)*response_len);
	return 0;
}

int edgez_config_handle_packet(const uint8_t *payload, size_t payload_len,
			       uint8_t *response_buf, size_t response_cap,
			       size_t *response_len)
{
	return handle_packet_internal(payload, payload_len, response_buf, response_cap,
				      response_len, false);
}

static uint64_t mac_to_node_id(const uint8_t mac[6])
{
	uint64_t value = 0;
	for (size_t i = 0; i < 6; ++i) value = (value << 8) | mac[i];
	return value;
}

int edgez_config_build_status_packet(uint8_t *out, size_t out_cap,
				     size_t *out_len)
{
	ai_edgez_halow_NetworkPacket packet = ai_edgez_halow_NetworkPacket_init_zero;
	pb_ostream_t stream;

	if (!out || !out_len) return -EINVAL;
	packet.operation = ai_edgez_halow_Operation_RESPONSE;
	packet.interface = ai_edgez_halow_Interface_HALOW;
	packet.which_body = ai_edgez_halow_NetworkPacket_status_tag;
	k_mutex_lock(&config_lock, K_FOREVER);
	packet.from = mac_to_node_id(halow_mac);
	fill_status_locked(&packet.body.status);
	k_mutex_unlock(&config_lock);
	stream = pb_ostream_from_buffer(out, out_cap);
	if (!pb_encode(&stream, ai_edgez_halow_NetworkPacket_fields, &packet)) {
		return -EMSGSIZE;
	}
	*out_len = stream.bytes_written;
	return 0;
}

int edgez_config_build_zero_touch_request(const uint8_t current_mac[6],
					   uint8_t *out, size_t out_cap,
					   size_t *out_len)
{
	ai_edgez_halow_NetworkPacket packet = ai_edgez_halow_NetworkPacket_init_zero;
	struct edgez_factory_identity factory;
	pb_ostream_t stream;

	if (!current_mac || !out || !out_len) {
		return -EINVAL;
	}
	/* This copies the boot-time factory cache; it does not read flash. A
	 * zero-touch request must never advertise a profile or temporary key. */
	if (edgez_factory_data_get(&factory) != 0) {
		return -ENODATA;
	}
	packet.from = mac_to_node_id(current_mac);
	packet.operation = ai_edgez_halow_Operation_REQUEST;
	packet.interface = ai_edgez_halow_Interface_HALOW;
	packet.which_body = ai_edgez_halow_NetworkPacket_device_settings_tag;
	packet.body.device_settings.action =
		ai_edgez_halow_DeviceSettingsAction_DEVICE_SETTINGS_REPORT;
	copy_string(packet.body.device_settings.user_name,
		    sizeof(packet.body.device_settings.user_name),
		    factory.serial);
	memcpy(&packet.body.device_settings.user_id_high, factory.public_key,
	       sizeof(packet.body.device_settings.user_id_high));
	memcpy(&packet.body.device_settings.user_id_low, factory.public_key + 8,
	       sizeof(packet.body.device_settings.user_id_low));
	packet.body.device_settings.user_public_key.size = EDGEZ_FACTORY_KEY_SIZE;
	memcpy(packet.body.device_settings.user_public_key.bytes, factory.public_key,
	       EDGEZ_FACTORY_KEY_SIZE);
	packet.body.device_settings.device_type =
		ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR;
	packet.body.device_settings.sleep_mode_enabled = true;
	memset(&factory, 0, sizeof(factory));
	stream = pb_ostream_from_buffer(out, out_cap);
	if (!pb_encode(&stream, ai_edgez_halow_NetworkPacket_fields, &packet)) {
		return -EMSGSIZE;
	}
	*out_len = stream.bytes_written;
	return 0;
}

int edgez_config_build_network_beacon(const uint8_t current_mac[6],
				      uint8_t *out, size_t out_cap,
				      size_t *out_len)
{
	ai_edgez_halow_NetworkPacket packet = ai_edgez_halow_NetworkPacket_init_zero;
	pb_ostream_t stream;

	if (!current_mac || !out || !out_len) return -EINVAL;
	packet.from = mac_to_node_id(current_mac);
	packet.operation = ai_edgez_halow_Operation_BROADCAST;
	packet.interface = ai_edgez_halow_Interface_HALOW;
	packet.which_body = ai_edgez_halow_NetworkPacket_beacon_tag;
	k_mutex_lock(&config_lock, K_FOREVER);
	packet.body.beacon.user_id_high = settings.user_id_high;
	packet.body.beacon.user_id_low = settings.user_id_low;
	copy_string(packet.body.beacon.user_name, sizeof(packet.body.beacon.user_name),
		    settings.user_name);
	packet.body.beacon.user_public_key.size = settings.user_public_key.size;
	memcpy(packet.body.beacon.user_public_key.bytes,
	       settings.user_public_key.bytes,
	       settings.user_public_key.size);
	if (settings.share_location) {
		packet.body.beacon.latitude = settings.latitude;
		packet.body.beacon.longitude = settings.longitude;
	}
	packet.body.beacon.marker = settings.marker;
	packet.body.beacon.device_type = settings.device_type;
	copy_string(packet.body.beacon.icon_style,
		    sizeof(packet.body.beacon.icon_style), settings.icon_style);
	k_mutex_unlock(&config_lock);
	stream = pb_ostream_from_buffer(out, out_cap);
	if (!pb_encode(&stream, ai_edgez_halow_NetworkPacket_fields, &packet)) {
		return -EMSGSIZE;
	}
	*out_len = stream.bytes_written;
	return 0;
}

int edgez_config_build_vendor_ies(uint8_t *out, size_t out_cap,
				  const uint8_t current_mac[6], size_t *out_len)
{
	ai_edgez_halow_DeviceSettings snapshot;
	ai_edgez_halow_Beacon beacon = ai_edgez_halow_Beacon_init_zero;
	struct edgez_gps_fix gps_fix;
	struct edgez_imu_sample imu_sample;
	int32_t battery_mv;
	pb_ostream_t stream;
	size_t off = 2U + EDGEZ_VENDOR_LEN;

	if (!out || !out_len || !current_mac || out_cap < off) {
		return -EINVAL;
	}
	ARG_UNUSED(current_mac);
	k_mutex_lock(&config_lock, K_FOREVER);
	snapshot = settings;
	k_mutex_unlock(&config_lock);
	if ((snapshot.user_id_high == 0 && snapshot.user_id_low == 0) ||
	    snapshot.user_name[0] == '\0' || snapshot.user_public_key.size == 0 ||
	    snapshot.device_type < ai_edgez_halow_DeviceType_DEVICE_TYPE_USER ||
	    snapshot.device_type > ai_edgez_halow_DeviceType_DEVICE_TYPE_RELAY) {
		return -EINVAL;
	}
	beacon.user_id_high = snapshot.user_id_high;
	beacon.user_id_low = snapshot.user_id_low;
	copy_string(beacon.user_name, sizeof(beacon.user_name), snapshot.user_name);
	beacon.user_public_key.size = snapshot.user_public_key.size;
	memcpy(beacon.user_public_key.bytes, snapshot.user_public_key.bytes,
	       snapshot.user_public_key.size);
	beacon.marker = snapshot.marker;
	beacon.device_type = snapshot.device_type;
	copy_string(beacon.icon_style, sizeof(beacon.icon_style), snapshot.icon_style);
	/* Match edge-device-esp32-internal management beacon encoding exactly:
	 * location is SensorData and is reserved before the sampled IMU entries.
	 * The legacy top-level latitude/longitude and sleeping fields remain zero. */
	bool has_location = false;
	float latitude_value = snapshot.latitude;
	float longitude_value = snapshot.longitude;

	if ((snapshot.device_gps_enabled ||
	     IS_ENABLED(CONFIG_OFFGRID_NRF54_SENSOR_GPS)) &&
	    edgez_gps_get_fix(&gps_fix)) {
		latitude_value = gps_fix.latitude;
		longitude_value = gps_fix.longitude;
		has_location = true;
	} else if (!snapshot.device_gps_enabled && snapshot.share_location) {
		has_location = true;
	}
	if (has_location &&
	    isfinite(latitude_value) && isfinite(longitude_value) &&
	    latitude_value >= -90.0f && latitude_value <= 90.0f &&
	    longitude_value >= -180.0f && longitude_value <= 180.0f &&
	    (latitude_value != 0.0f || longitude_value != 0.0f)) {
		ai_edgez_halow_SensorData *latitude =
			&beacon.sensor_data[beacon.sensor_data_count++];
		ai_edgez_halow_SensorData *longitude =
			&beacon.sensor_data[beacon.sensor_data_count++];

		latitude->type = ai_edgez_halow_SensorType_SENSOR_LATITUDE;
		latitude->which_value = ai_edgez_halow_SensorData_float_value_tag;
		latitude->value.float_value = latitude_value;
		longitude->type = ai_edgez_halow_SensorType_SENSOR_LONGITUDE;
		longitude->which_value = ai_edgez_halow_SensorData_float_value_tag;
		longitude->value.float_value = longitude_value;
	}
	int battery_rc = snapshot.sleep_mode_enabled ?
		edgez_battery_read_cached_mv(&battery_mv) :
		edgez_battery_read_mv(&battery_mv);

	if (battery_rc == 0 &&
	    beacon.sensor_data_count < ARRAY_SIZE(beacon.sensor_data)) {
		ai_edgez_halow_SensorData *battery =
			&beacon.sensor_data[beacon.sensor_data_count++];

		battery->type = ai_edgez_halow_SensorType_SENSOR_BATTERY_VOLTAGE;
		battery->which_value = ai_edgez_halow_SensorData_float_value_tag;
		battery->value.float_value = battery_mv / 1000.0f;
	}
	if ((snapshot.device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_BEACON ||
	     snapshot.device_type == ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR) &&
	    edgez_imu_is_ready()) {
		int imu_rc = edgez_imu_read(&imu_sample);

		if (imu_rc < 0) {
			LOG_WRN("IMU beacon sample failed: %d", imu_rc);
		} else {
			static const ai_edgez_halow_SensorType accel_types[] = {
				ai_edgez_halow_SensorType_SENSOR_ACCEL_X,
				ai_edgez_halow_SensorType_SENSOR_ACCEL_Y,
				ai_edgez_halow_SensorType_SENSOR_ACCEL_Z,
			};
			const float accel_values[] = {
				imu_sample.accel_m_s2[0], imu_sample.accel_m_s2[1],
				imu_sample.accel_m_s2[2],
			};

			for (size_t i = 0;
			     i < ARRAY_SIZE(accel_types) && beacon.sensor_data_count < ARRAY_SIZE(beacon.sensor_data);
			     i++) {
				ai_edgez_halow_SensorData *entry =
					&beacon.sensor_data[beacon.sensor_data_count++];

				entry->type = accel_types[i];
				entry->which_value = ai_edgez_halow_SensorData_float_value_tag;
				entry->value.float_value = accel_values[i];
			}
			if (imu_sample.gyro_valid) {
				static const ai_edgez_halow_SensorType gyro_types[] = {
					ai_edgez_halow_SensorType_SENSOR_GYRO_X,
					ai_edgez_halow_SensorType_SENSOR_GYRO_Y,
					ai_edgez_halow_SensorType_SENSOR_GYRO_Z,
				};

				for (size_t i = 0;
				     i < ARRAY_SIZE(gyro_types) && beacon.sensor_data_count < ARRAY_SIZE(beacon.sensor_data);
				     i++) {
					ai_edgez_halow_SensorData *entry =
						&beacon.sensor_data[beacon.sensor_data_count++];

					entry->type = gyro_types[i];
					entry->which_value = ai_edgez_halow_SensorData_float_value_tag;
					entry->value.float_value = imu_sample.gyro_rad_s[i];
				}
			}
			LOG_DBG("IMU beacon sample accel=[%.3f %.3f %.3f] m/s2 gyro=[%.3f %.3f %.3f] rad/s",
				(double)imu_sample.accel_m_s2[0], (double)imu_sample.accel_m_s2[1],
				(double)imu_sample.accel_m_s2[2], (double)imu_sample.gyro_rad_s[0],
				(double)imu_sample.gyro_rad_s[1], (double)imu_sample.gyro_rad_s[2]);
		}
	}
	stream = pb_ostream_from_buffer(&out[off], out_cap - off);
	if (!pb_encode(&stream, ai_edgez_halow_Beacon_fields, &beacon) ||
	    stream.bytes_written > (UINT8_MAX - EDGEZ_VENDOR_LEN)) {
		return -EMSGSIZE;
	}
	out[0] = EDGEZ_IE_ID;
	out[1] = (uint8_t)(EDGEZ_VENDOR_LEN + stream.bytes_written);
	memcpy(&out[2], EDGEZ_VENDOR, EDGEZ_VENDOR_LEN);
	off += stream.bytes_written;
	*out_len = off;
	{
		k_spinlock_key_t key = k_spin_lock(&beacon_vendor_ies_lock);

		memcpy(beacon_vendor_ies, out, off);
		beacon_vendor_ies_len = off;
		k_spin_unlock(&beacon_vendor_ies_lock, key);
	}
	LOG_DBG("EdgeZ HaLow compact beacon IE built len=%u protobuf=%u device_type=%d user=%016llx-%016llx",
		(unsigned)off, (unsigned)stream.bytes_written, snapshot.device_type,
		(unsigned long long)beacon.user_id_high,
		(unsigned long long)beacon.user_id_low);
	return 0;
}

int edgez_config_copy_halow_beacon(uint8_t *out, size_t out_cap,
				   size_t *out_len)
{
	size_t payload_offset = 2U + EDGEZ_VENDOR_LEN;
	size_t payload_len;
	k_spinlock_key_t key;

	if (!out || !out_len) {
		return -EINVAL;
	}
	key = k_spin_lock(&beacon_vendor_ies_lock);
	payload_len = beacon_vendor_ies_len > payload_offset ?
		beacon_vendor_ies_len - payload_offset : 0U;
	if (payload_len == 0U || payload_len > out_cap) {
		k_spin_unlock(&beacon_vendor_ies_lock, key);
		return payload_len == 0U ? -EAGAIN : -ENOSPC;
	}
	memcpy(out, &beacon_vendor_ies[payload_offset], payload_len);
	k_spin_unlock(&beacon_vendor_ies_lock, key);
	*out_len = payload_len;
	return 0;
}
