#include <zephyr/autoconf.h>

#if defined(CONFIG_WIFI_MORSEMICRO_EDGEZ_JOIN_ONLY)

/*
 * Copyright 2026 EdgeZeron AI AB
 * SPDX-License-Identifier: Apache-2.0
 */

#include <inttypes.h>
#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/reboot.h>

#include "pb_decode.h"
#include "pb_encode.h"

#include "edgez_diagnostics.h"
#include "edgez_batman_adv_lite.h"
#include "edgez_ble.h"
#include "edgez_battery.h"
#include "edgez_config.h"
#include "edgez_gps.h"
#include "edgez_imu.h"
#include "edgez_mesh_channel_policy.h"
#include "edgez_mesh_data_frame.h"
#include "edgez_mesh_msdu.h"
#include "edgez_mesh_relay.h"
#include "edgez_mesh_zephyr.h"
#include "edgez_pawr_protocol.h"
#include "edgez_mesh_sae_provider.h"
#include "edgez_rf_api.h"
#include "edgez_umac_mesh_runtime.h"
#include "edgez_reboot.h"
#include "livestocking_config.h"
#include "usb_control.pb.h"

#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
#include "mmhal_wlan.h"
#include "mmwlan.h"

extern enum mmwlan_status mmdrv_set_wake_enabled(bool enabled);
extern enum mmwlan_status mmdrv_set_chip_power_save_enabled(uint16_t vif_id,
							     bool enabled);
extern enum mmwlan_status mmdrv_set_dynamic_ps_timeout(uint32_t timeout_ms);
#endif

LOG_MODULE_REGISTER(edgez_mesh_join, LOG_LEVEL_INF);

#define EDGEZ_MESH_PRIMARY_BANDWIDTH_MHZ 1U
#define EDGEZ_MESH_BEACON_INTERVAL_TU 100U
#define EDGEZ_MESH_TICK_MS 100U
#define EDGEZ_MESH_REPORT_MS 2000U
#define EDGEZ_SENSOR_PAWR_ATTEMPTS 3U
#define EDGEZ_SENSOR_RESPONSE_TIMEOUT_MS 2000U
#define EDGEZ_SENSOR_RETRY_DELAY_MS 150U
#define EDGEZ_SENSOR_UPDATE_INTERVAL_MS 15000U
#define EDGEZ_SENSOR_GPS_TIMEOUT_MS 10000U
#define EDGEZ_BUTTON_DEBOUNCE_MS 50U
#define EDGEZ_BUTTON_RESET_HOLD_MS 5000U
#define EDGEZ_USER_NODE DT_PATH(zephyr_user)

#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
#define EDGEZ_PS_BASELINE_MS 30000U
#define EDGEZ_PS_REPORT_MS 30000U
#define EDGEZ_PS_SETTLE_MS 2000U
#define EDGEZ_PS_SAMPLE_MS 10U
#define EDGEZ_PS_DYNAMIC_TIMEOUT_MS 100U
#endif

static struct edgez_umac_mesh_runtime mesh_runtime;
static struct edgez_mesh_sae_provider sae_provider;
static uint32_t tx_status_count;
static uint32_t tx_failure_count;
static uint32_t batman_tx_count;
static uint32_t batman_tx_failure_count;
static uint32_t previous_operation_failures;
static uint32_t previous_handler_failures;
static uint32_t applied_generation;
static struct edgez_halow_profile applied_profile;
static bool mesh_started;
static bool mesh_secure;
static bool sensor_radio_only;
static uint16_t open_data_sequence;
static uint32_t open_mesh_sequence;
static uintptr_t open_tx_token;
static uintptr_t pawr_tx_token;
static uint16_t pawr_sequence_number;
static uint32_t pawr_request_id;
static bool mesh_services_initialized;
static struct k_spinlock sensor_pawr_lock;
static uint32_t sensor_pawr_expected_hash;
static bool sensor_pawr_waiting;
K_SEM_DEFINE(sensor_pawr_response_sem, 0, 1);
#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, key_gpios)
static const struct gpio_dt_spec user_button =
	GPIO_DT_SPEC_GET(EDGEZ_USER_NODE, key_gpios);
static bool user_button_ready;
#endif
K_MUTEX_DEFINE(batman_state_lock);
K_MUTEX_DEFINE(batman_tx_lock);
#define EDGEZ_OPEN_DATA_FRAME_MAX (EDGEZ_MESH_QOS_4ADDR_HEADER_LEN + \
	EDGEZ_MESH_CONTROL_MAX_LEN + EDGEZ_RFC1042_HEADER_LEN + \
	EDGEZ_BATADV_MAX_PACKET_LEN)
static uint8_t open_data_frame[EDGEZ_OPEN_DATA_FRAME_MAX];

static bool profile_uses_sensor_mode(const struct edgez_halow_profile *profile);

static uint64_t mac_to_u64(const uint8_t mac[6])
{
	uint64_t value = 0U;

	for (size_t i = 0; i < 6U; ++i) {
		value = (value << 8U) | mac[i];
	}
	return value;
}

static int acknowledge_pawr_beacon(const struct edgez_pawr_action_view *action,
				   const uint8_t *beacon, size_t beacon_len)
{
	uint8_t response[EDGEZ_PAWR_HEADER_LENGTH];
	uint8_t frame[EDGEZ_PAWR_ACTION_HEADER_LENGTH + sizeof(response)];
	size_t response_len = 0U;
	size_t frame_len = 0U;

	if (!edgez_pawr_encode_response(response, sizeof(response),
			edgez_pawr_payload_hash(beacon, beacon_len), &response_len) ||
	    !edgez_pawr_encode_action_frame(frame, sizeof(frame),
			pawr_sequence_number++, mesh_runtime.radio_info.mac_addr,
			action->source, response, response_len, &frame_len)) {
		return -EMSGSIZE;
	}

	const struct edgez_umac_tx_request request = {
		.token = pawr_tx_token++,
		.frame = frame,
		.frame_length = frame_len,
		.frame_type = EDGEZ_UMAC_TX_MANAGEMENT,
		.aid = 0U,
		.tid = 8U,
		.mcs = mesh_runtime.config.mcs,
		.attempts = mesh_runtime.config.attempts,
		.bandwidth_mhz = mesh_runtime.config.channel.operating_bw_mhz,
		.short_guard = mesh_runtime.config.short_guard,
		.immediate_status = true,
	};
	return edgez_umac_transmit(&mesh_runtime.umac, &request) == EDGEZ_UMAC_OK ?
		0 : -EIO;
}

static int route_pawr_beacon(const uint8_t source[6], const uint8_t *beacon,
			     size_t beacon_len)
{
	ai_edgez_halow_NetworkPacket *packet =
		k_calloc(1U, sizeof(ai_edgez_halow_NetworkPacket));
	uint8_t encoded[512];
	int rc;

	if (!packet) {
		return -ENOMEM;
	}
	pb_istream_t input = pb_istream_from_buffer(beacon, beacon_len);
	packet->from = mac_to_u64(source);
	packet->operation = ai_edgez_halow_Operation_BROADCAST;
	packet->interface = ai_edgez_halow_Interface_HALOW;
	packet->which_body = ai_edgez_halow_NetworkPacket_beacon_tag;
	if (!pb_decode(&input, ai_edgez_halow_Beacon_fields,
		       &packet->body.beacon)) {
		LOG_WRN("PAwR Beacon decode failed: %s", PB_GET_ERROR(&input));
		k_free(packet);
		return -EINVAL;
	}
	pb_ostream_t output = pb_ostream_from_buffer(encoded, sizeof(encoded));
	if (!pb_encode(&output, ai_edgez_halow_NetworkPacket_fields, packet)) {
		LOG_WRN("PAwR NetworkPacket encode failed: %s", PB_GET_ERROR(&output));
		k_free(packet);
		return -EMSGSIZE;
	}
	k_free(packet);

	if (edgez_ble_can_notify()) {
		rc = edgez_ble_notify_packet(encoded, output.bytes_written);
		if (rc == 0) {
			LOG_INF("PAwR Beacon routed via BLE bytes=%u packet=%u",
				(unsigned)beacon_len, (unsigned)output.bytes_written);
			return 0;
		}
		LOG_WRN("PAwR Beacon BLE forwarding failed rc=%d; using HaLow mesh", rc);
	}

	rc = edgez_nrf_relay_send(NULL, encoded, output.bytes_written);
	if (rc == 0) {
		LOG_INF("PAwR Beacon routed via HaLow mesh bytes=%u packet=%u",
			(unsigned)beacon_len, (unsigned)output.bytes_written);
	} else {
		LOG_WRN("PAwR Beacon HaLow mesh broadcast failed rc=%d", rc);
	}
	return rc;
}

#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
enum mesh_ps_phase {
	MESH_PS_WAITING,
	MESH_PS_SETTLING,
	MESH_PS_BASELINE,
	MESH_PS_ENABLED,
};

static enum mesh_ps_phase mesh_ps_phase = MESH_PS_WAITING;
static uint32_t mesh_ps_phase_started;
static uint32_t mesh_ps_busy_samples;
static uint32_t mesh_ps_total_samples;
static uint32_t mesh_ps_baseline_x10;
#endif

extern bool edgez_halow_power_is_ready(void);
extern int edgez_halow_power_set(bool enabled);

#if EDGEZ_DIAGNOSTICS_ENABLED && !defined(EDGEZ_PLATFORM_ARCHIVE_BUILD)
static void join_diagnostic_sink(void *ctx,
				 enum edgez_diagnostic_level level,
				 const char *component,
				 const char *message)
{
	ARG_UNUSED(ctx);

	switch (level) {
	case EDGEZ_DIAGNOSTIC_ERROR:
		LOG_ERR("[%s] %s", component, message);
		break;
	case EDGEZ_DIAGNOSTIC_WARNING:
		LOG_WRN("[%s] %s", component, message);
		break;
	case EDGEZ_DIAGNOSTIC_INFO:
		LOG_INF("[%s] %s", component, message);
		break;
	case EDGEZ_DIAGNOSTIC_DEBUG:
		LOG_DBG("[%s] %s", component, message);
		break;
	case EDGEZ_DIAGNOSTIC_OFF:
	default:
		break;
	}
}
#endif

void edgez_request_reboot(uint32_t reason)
{
	ARG_UNUSED(reason);
	LOG_WRN("Reboot request ignored by join-only validation image");
}

static int reset_settings_storage(void)
{
	const struct flash_area *storage;
	int rc = flash_area_open(PARTITION_ID(storage_partition), &storage);

	if (rc != 0) {
		return rc;
	}
	LOG_WRN("Erasing settings storage partition (%u bytes)",
		(unsigned)storage->fa_size);
	rc = flash_area_erase(storage, 0, storage->fa_size);
	flash_area_close(storage);
	return rc;
}

static void configure_user_button(void)
{
#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, key_gpios)
	if (!gpio_is_ready_dt(&user_button)) {
		LOG_WRN("KEY GPIO is not ready");
		return;
	}
	int rc = gpio_pin_configure_dt(&user_button, GPIO_INPUT);

	if (rc != 0) {
		LOG_WRN("KEY GPIO configuration failed rc=%d", rc);
		return;
	}
	user_button_ready = true;
	LOG_INF("Hold KEY for %u seconds to clear settings",
		EDGEZ_BUTTON_RESET_HOLD_MS / 1000U);
#endif
}

static void poll_user_button(void)
{
#if DT_NODE_HAS_PROP(EDGEZ_USER_NODE, key_gpios)
	static bool was_pressed;
	static int64_t pressed_at_ms;

	if (!user_button_ready) {
		return;
	}
	int pressed = gpio_pin_get_dt(&user_button);
	if (pressed < 0) {
		LOG_ERR("KEY read failed rc=%d", pressed);
		user_button_ready = false;
		return;
	}
	int64_t now_ms = k_uptime_get();
	if (pressed && !was_pressed) {
		pressed_at_ms = now_ms;
		LOG_INF("KEY pressed");
	} else if (!pressed && was_pressed) {
		int64_t held_ms = now_ms - pressed_at_ms;

		if (held_ms >= EDGEZ_BUTTON_RESET_HOLD_MS) {
			int rc = reset_settings_storage();

			if (rc == 0) {
				LOG_WRN("settings erased after KEY hold; rebooting unprovisioned");
				sys_reboot(SYS_REBOOT_COLD);
			}
			LOG_ERR("settings erase failed rc=%d", rc);
		} else if (held_ms >= EDGEZ_BUTTON_DEBOUNCE_MS) {
			LOG_INF("KEY short press");
		}
	}
	was_pressed = pressed != 0;
#endif
}

static int deliver_msdu(const uint8_t destination[6], const uint8_t source[6],
			const uint8_t transmitter[6], const uint8_t *payload,
			size_t payload_length)
{
	struct edgez_mesh_msdu msdu;
	uint8_t ethernet[EDGEZ_ETHERNET_HEADER_LEN + EDGEZ_BATADV_MAX_PACKET_LEN];
	size_t ethernet_length = 0;
	int rc = edgez_mesh_msdu_decode(&msdu, destination, source, payload,
					payload_length);
	if (rc == EDGEZ_UMAC_OK) {
		rc = edgez_mesh_msdu_to_ethernet(&msdu, ethernet, sizeof(ethernet),
						 &ethernet_length);
	}
	if (rc == EDGEZ_UMAC_OK) {
		(void)edgez_nrf_mesh_receive_ethernet(ethernet, ethernet_length,
						      transmitter);
	}
	return rc;
}

static int join_receive_data(void *ctx, const struct edgez_umac_rx_frame *radio,
			     const struct edgez_mesh_rx_data *frame)
{
	ARG_UNUSED(ctx);
	ARG_UNUSED(radio);
	return deliver_msdu(frame->destination, frame->source, frame->transmitter,
			    frame->payload, frame->payload_length);
}

static int join_receive_protected_data(
	void *ctx, const struct edgez_umac_rx_frame *radio,
	const struct edgez_mesh_rx_protected_data *frame)
{
	ARG_UNUSED(ctx);
	ARG_UNUSED(radio);
	uint8_t plaintext[EDGEZ_BATADV_MAX_PACKET_LEN];
	size_t plaintext_length = 0;
	uint64_t packet_number = 0;
	int rc = edgez_mesh_sae_provider_decrypt_data(
		&sae_provider, frame, plaintext, sizeof(plaintext),
		&plaintext_length, &packet_number);
	ARG_UNUSED(packet_number);
	return rc == EDGEZ_UMAC_OK ?
		deliver_msdu(frame->destination, frame->source, frame->transmitter,
			     plaintext, plaintext_length) : rc;
}

static int join_drop_qos_null(void *ctx,
			      const struct edgez_umac_rx_frame *radio,
			      const struct edgez_mesh_rx_qos_null *frame)
{
	ARG_UNUSED(ctx);
	ARG_UNUSED(radio);
	ARG_UNUSED(frame);
	return EDGEZ_UMAC_OK;
}

static int join_ignore_unsupported(void *ctx,
				   const struct edgez_umac_rx_frame *radio)
{
	ARG_UNUSED(ctx);
	struct edgez_pawr_action_view action;
	struct edgez_pawr_request_view request;
	uint32_t response_hash;

	if (!radio || !edgez_pawr_decode_action_frame(
			radio->data, radio->length, &action)) {
		return EDGEZ_UMAC_OK;
	}
	if (edgez_pawr_decode_request(action.payload, action.payload_length,
				      &request) &&
	    request.type == EDGEZ_PAWR_REQUEST_MESH_PACKET) {
		(void)edgez_nrf_mesh_receive_pawr(
			request.payload, request.payload_length, action.source);
		return EDGEZ_UMAC_OK;
	}
	if (edgez_pawr_decode_request(action.payload, action.payload_length,
				      &request) &&
	    request.type == EDGEZ_PAWR_REQUEST_BEACON) {
		LOG_INF("PAwR beacon request=%u from=%02x:%02x:%02x:%02x:%02x:%02x RSSI=%d dBm bytes=%u",
			request.request_id, action.source[0], action.source[1],
			action.source[2], action.source[3], action.source[4],
			action.source[5], radio->rssi_dbm,
			(unsigned)request.payload_length);
		int rc = acknowledge_pawr_beacon(&action, request.payload,
					 request.payload_length);
		if (rc != 0) {
			LOG_WRN("PAwR beacon acknowledgement failed rc=%d", rc);
		}
		if (!profile_uses_sensor_mode(&applied_profile)) {
			rc = route_pawr_beacon(action.source, request.payload,
					       request.payload_length);
			if (rc != 0) {
				LOG_WRN("PAwR Beacon routing exhausted rc=%d", rc);
			}
		}
		return EDGEZ_UMAC_OK;
	}
	if (edgez_pawr_decode_response(action.payload, action.payload_length,
				       &response_hash)) {
		k_spinlock_key_t key = k_spin_lock(&sensor_pawr_lock);
		bool matched = sensor_pawr_waiting &&
			response_hash == sensor_pawr_expected_hash;

		if (matched) {
			sensor_pawr_waiting = false;
		}
		k_spin_unlock(&sensor_pawr_lock, key);
		if (matched) {
			LOG_INF("sensor PAwR response hash=%08x from=%02x:%02x:%02x:%02x:%02x:%02x RSSI=%d dBm",
				response_hash, action.source[0], action.source[1],
				action.source[2], action.source[3], action.source[4],
				action.source[5], radio->rssi_dbm);
			k_sem_give(&sensor_pawr_response_sem);
		}
	}
	return EDGEZ_UMAC_OK;
}

static void join_hardware_restart(void *ctx)
{
	ARG_UNUSED(ctx);
	LOG_ERR("Morse RF requested a hardware restart");
}

static void join_tx_status(void *ctx,
			   const struct edgez_umac_tx_status *status)
{
	ARG_UNUSED(ctx);
	tx_status_count++;
	LOG_INF("mesh TX status token=%" PRIuPTR " len=%u attempts=%u flags=0x%08" PRIx32,
		status->token, (unsigned)status->frame_length,
		status->attempts, status->status_flags);
	if ((status->status_flags & EDGEZ_RF_TX_STATUS_FAILED) != 0U) {
		tx_failure_count++;
		LOG_WRN("mesh TX failed token=%" PRIuPTR " len=%u attempts=%u",
			status->token, (unsigned)status->frame_length,
			status->attempts);
	}
}

static const struct edgez_umac_mesh_runtime_events join_events = {
	.data = join_receive_data,
	.protected_data = join_receive_protected_data,
	.qos_null = join_drop_qos_null,
	.unsupported = join_ignore_unsupported,
	.tx_status = join_tx_status,
	.hardware_restart_required = join_hardware_restart,
};

static const char *peering_state_name(enum edgez_mesh_peering_state state)
{
	switch (state) {
	case EDGEZ_PEERING_IDLE: return "idle";
	case EDGEZ_PEERING_SAE_AUTHENTICATING: return "sae";
	case EDGEZ_PEERING_OPEN_SENT: return "open-sent";
	case EDGEZ_PEERING_OPEN_RECEIVED: return "open-received";
	case EDGEZ_PEERING_CONFIRM_RECEIVED: return "confirm-received";
	case EDGEZ_PEERING_ESTABLISHED: return "established";
	case EDGEZ_PEERING_HOLDING: return "holding";
	default: return "unknown";
	}
}

static bool has_established_peer(void)
{
	for (size_t i = 0; i < EDGEZ_UMAC_MAX_PEERS; ++i) {
		const struct edgez_mesh_peering_slot *slot =
			&mesh_runtime.peering_manager.slots[i];
		if (slot->in_use &&
		    slot->peering.state == EDGEZ_PEERING_ESTABLISHED) {
			return true;
		}
	}
	return false;
}

static size_t batman_snapshot_peers(void *ctx, uint8_t (*peers)[6],
				    size_t capacity)
{
	struct edgez_umac_mesh_runtime *runtime = ctx;
	size_t count = 0;

	for (size_t i = 0; i < EDGEZ_UMAC_MAX_PEERS && count < capacity; ++i) {
		const struct edgez_umac_peer *peer = &runtime->umac.peers[i];
		if (peer->in_use && peer->state == EDGEZ_UMAC_PEER_AUTHORIZED) {
			memcpy(peers[count++], peer->mac_addr, 6);
		}
	}
	return count;
}

static int batman_transmit(void *ctx, const uint8_t *frame, size_t frame_len,
			   const uint8_t receiver[6])
{
	ARG_UNUSED(ctx);
	int rc;

	k_mutex_lock(&batman_tx_lock, K_FOREVER);
	if (mesh_secure) {
		rc = edgez_mesh_sae_provider_transmit_ethernet(
			&sae_provider, receiver, frame, frame_len, 0);
	} else {
		const struct edgez_umac_peer *peer =
			edgez_umac_peer_find(&mesh_runtime.umac, receiver);
		if (!peer || peer->state != EDGEZ_UMAC_PEER_AUTHORIZED) {
			k_mutex_unlock(&batman_tx_lock);
			return -ENOENT;
		}
		struct edgez_mesh_data_header header = {
			.sequence_number = open_data_sequence++ & 0x0fffU,
			.tid = 0,
			.protected_frame = false,
			.mesh_control = {
				.address_extension = EDGEZ_MESH_AE_ADDR5_ADDR6,
				.ttl = 31U,
				.sequence_number = open_mesh_sequence++,
			},
		};
		size_t encoded_length = 0;
		memcpy(header.receiver, receiver, 6);
		memcpy(header.transmitter, mesh_runtime.radio_info.mac_addr, 6);
		memcpy(header.destination, frame, 6);
		memcpy(header.source, mesh_runtime.radio_info.mac_addr, 6);
		memcpy(header.mesh_control.address5, frame, 6);
		memcpy(header.mesh_control.address6, frame + 6, 6);
		rc = edgez_mesh_data_frame_encode(open_data_frame,
						  sizeof(open_data_frame), &header,
						  frame, frame_len, &encoded_length);
		if (rc == EDGEZ_UMAC_OK) {
			const struct edgez_umac_tx_request request = {
				.token = open_tx_token++,
				.frame = open_data_frame,
				.frame_length = encoded_length,
				.frame_type = EDGEZ_UMAC_TX_DATA,
				.aid = peer->aid,
				.tid = 0,
				.mcs = 0,
				.attempts = 2,
				.bandwidth_mhz = (uint8_t)applied_profile.mesh_bandwidth_mhz,
				.immediate_status = true,
			};
			rc = edgez_umac_transmit(&mesh_runtime.umac, &request);
		}
	}
	k_mutex_unlock(&batman_tx_lock);
	batman_tx_count++;
	if (rc != EDGEZ_UMAC_OK) {
		batman_tx_failure_count++;
		LOG_WRN("BATMAN radio TX rejected peer=%02x:%02x:%02x:%02x:%02x:%02x len=%u rc=%d",
			receiver[0], receiver[1], receiver[2], receiver[3],
			receiver[4], receiver[5], (unsigned)frame_len, rc);
	}
	return rc == EDGEZ_UMAC_OK ? 0 : -EIO;
}

static int batman_transmit_pawr(void *ctx, const uint8_t destination[6],
			       const uint8_t *frame, size_t frame_len)
{
	ARG_UNUSED(ctx);
	uint8_t packet[EDGEZ_PAWR_HEADER_LENGTH + EDGEZ_PAWR_MAX_ACTION_PAYLOAD];
	uint8_t action[EDGEZ_PAWR_ACTION_HEADER_LENGTH + sizeof(packet)];
	size_t packet_len = 0U;
	size_t action_len = 0U;
	uint32_t request_id = ++pawr_request_id;

	if (!edgez_pawr_encode_mesh_packet(packet, sizeof(packet), request_id,
					   frame, frame_len, &packet_len) ||
	    !edgez_pawr_encode_action_frame(
			action, sizeof(action), pawr_sequence_number++,
			mesh_runtime.radio_info.mac_addr, destination,
			packet, packet_len, &action_len)) {
		return -EMSGSIZE;
	}
	const struct edgez_umac_tx_request request = {
		.token = pawr_tx_token++,
		.frame = action,
		.frame_length = action_len,
		.frame_type = EDGEZ_UMAC_TX_MANAGEMENT,
		.aid = 0U,
		.tid = 8U,
		.mcs = mesh_runtime.config.mcs,
		.attempts = mesh_runtime.config.attempts,
		.bandwidth_mhz = mesh_runtime.config.channel.operating_bw_mhz,
		.short_guard = mesh_runtime.config.short_guard,
		.immediate_status = true,
	};
	int rc = edgez_umac_transmit(&mesh_runtime.umac, &request);
	if (rc == EDGEZ_UMAC_OK) {
		LOG_INF("PAwR direct packet queued id=%u bytes=%u to=%02x:%02x:%02x:%02x:%02x:%02x",
			request_id, (unsigned)frame_len,
			destination[0], destination[1], destination[2],
			destination[3], destination[4], destination[5]);
		return 0;
	}
	LOG_WRN("PAwR direct packet failed id=%u rc=%d driver=%d",
		request_id, rc, mesh_runtime.umac.last_driver_status);
	return -EIO;
}

static uint32_t batman_clock_ms(void *ctx)
{
	ARG_UNUSED(ctx);
	return k_uptime_get_32();
}

static uint32_t batman_random(void *ctx)
{
	ARG_UNUSED(ctx);
	return sys_rand32_get();
}

static void batman_lock(void *ctx)
{
	ARG_UNUSED(ctx);
	k_mutex_lock(&batman_state_lock, K_FOREVER);
}

static void batman_unlock(void *ctx)
{
	ARG_UNUSED(ctx);
	k_mutex_unlock(&batman_state_lock);
}

static const struct edgez_nrf_mesh_transport batman_transport = {
	.peers = batman_snapshot_peers,
	.transmit = batman_transmit,
	.transmit_pawr = batman_transmit_pawr,
	.clock_ms = batman_clock_ms,
	.random = batman_random,
	.lock = batman_lock,
	.unlock = batman_unlock,
	.ctx = &mesh_runtime,
};

static uint32_t compressed_ssid(const uint8_t *data, size_t length)
{
	uint32_t crc = UINT32_C(0xffffffff);
	for (size_t i = 0; i < length; ++i) {
		crc ^= data[i];
		for (unsigned bit = 0; bit < 8; ++bit) {
			uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
			crc = (crc >> 1U) ^ (UINT32_C(0xedb88320) & mask);
		}
	}
	return ~crc;
}

static bool same_radio_profile(const struct edgez_halow_profile *a,
			       const struct edgez_halow_profile *b)
{
	return strcmp(a->country_code, b->country_code) == 0 &&
		strcmp(a->mesh_id, b->mesh_id) == 0 &&
		strcmp(a->passphrase, b->passphrase) == 0 &&
		a->mesh_frequency_khz == b->mesh_frequency_khz &&
		a->mesh_bandwidth_mhz == b->mesh_bandwidth_mhz;
}

static bool profile_uses_sensor_mode(const struct edgez_halow_profile *profile)
{
	return profile->sleep_mode_enabled &&
		(profile->device_type ==
			ai_edgez_halow_DeviceType_DEVICE_TYPE_BEACON ||
		 profile->device_type ==
			ai_edgez_halow_DeviceType_DEVICE_TYPE_SENSOR);
}

static int sensor_pawr_send_once(uint32_t wake_interval_ms)
{
	static const uint8_t broadcast[6] = {
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff
	};
	uint8_t vendor_ies[EDGEZ_VENDOR_IES_MAX_LEN];
	uint8_t beacon[EDGEZ_VENDOR_IES_MAX_LEN];
	uint8_t packet[EDGEZ_PAWR_HEADER_LENGTH + EDGEZ_VENDOR_IES_MAX_LEN];
	uint8_t action[EDGEZ_PAWR_ACTION_HEADER_LENGTH + sizeof(packet)];
	size_t vendor_ies_len = 0U;
	size_t beacon_len = 0U;
	size_t packet_len = 0U;
	size_t action_len = 0U;
	uint32_t request_id = ++pawr_request_id;
	uint32_t hash;
	int rc;

	/* Refresh GPS, battery and IMU values, then send only the protobuf payload
	 * carried by the vendor IE. This is the same sleepy beacon contract used by
	 * the ESP32 PAwR responder. */
	rc = edgez_config_build_vendor_ies(vendor_ies, sizeof(vendor_ies),
					   mesh_runtime.radio_info.mac_addr,
					   &vendor_ies_len);
	if (rc != 0 || edgez_config_copy_halow_beacon(
				beacon, sizeof(beacon), &beacon_len) != 0) {
		LOG_WRN("sensor PAwR payload unavailable rc=%d IE=%u", rc,
			(unsigned)vendor_ies_len);
		return rc != 0 ? rc : -EAGAIN;
	}
	hash = edgez_pawr_payload_hash(beacon, beacon_len);
	if (!edgez_pawr_encode_typed_request(
			packet, sizeof(packet), EDGEZ_PAWR_REQUEST_BEACON,
			request_id, wake_interval_ms, beacon, beacon_len,
			&packet_len) ||
	    !edgez_pawr_encode_action_frame(
			action, sizeof(action), pawr_sequence_number++,
			mesh_runtime.radio_info.mac_addr, broadcast,
			packet, packet_len, &action_len)) {
		return -EMSGSIZE;
	}

	k_sem_reset(&sensor_pawr_response_sem);
	k_spinlock_key_t key = k_spin_lock(&sensor_pawr_lock);
	sensor_pawr_expected_hash = hash;
	sensor_pawr_waiting = true;
	k_spin_unlock(&sensor_pawr_lock, key);

	const struct edgez_umac_tx_request request = {
		.token = pawr_tx_token++,
		.frame = action,
		.frame_length = action_len,
		.frame_type = EDGEZ_UMAC_TX_MANAGEMENT,
		.aid = 0U,
		.tid = 8U,
		.mcs = mesh_runtime.config.mcs,
		.attempts = mesh_runtime.config.attempts,
		.bandwidth_mhz = mesh_runtime.config.channel.operating_bw_mhz,
		.short_guard = mesh_runtime.config.short_guard,
		.immediate_status = true,
	};
	rc = edgez_umac_transmit(&mesh_runtime.umac, &request);
	if (rc != EDGEZ_UMAC_OK) {
		key = k_spin_lock(&sensor_pawr_lock);
		sensor_pawr_waiting = false;
		k_spin_unlock(&sensor_pawr_lock, key);
		LOG_WRN("sensor PAwR request=%u rejected rc=%d driver=%d",
			request_id, rc, mesh_runtime.umac.last_driver_status);
		return -EIO;
	}
	edgez_imu_note_halow_tx();
	LOG_INF("sensor PAwR request=%u queued payload=%u interval=%ums hash=%08x",
		request_id, (unsigned)beacon_len, wake_interval_ms, hash);
	if (k_sem_take(&sensor_pawr_response_sem,
			       K_MSEC(EDGEZ_SENSOR_RESPONSE_TIMEOUT_MS)) == 0) {
		return 0;
	}
	key = k_spin_lock(&sensor_pawr_lock);
	sensor_pawr_waiting = false;
	k_spin_unlock(&sensor_pawr_lock, key);
	return -ETIMEDOUT;
}

#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
static uint32_t busy_percent_x10(void)
{
	if (mesh_ps_total_samples == 0U) {
		return 0U;
	}
	return (uint32_t)(((uint64_t)mesh_ps_busy_samples * 1000U) /
			  mesh_ps_total_samples);
}

static void reset_samples(uint32_t now)
{
	mesh_ps_phase_started = now;
	mesh_ps_busy_samples = 0U;
	mesh_ps_total_samples = 0U;
}

static bool set_mesh_power_save(bool enabled)
{
	enum mmwlan_status status;

	if (enabled) {
		status = mmdrv_set_wake_enabled(false);
		if (status == MMWLAN_SUCCESS) {
			status = mmdrv_set_chip_power_save_enabled(
				mesh_runtime.umac.vif_id, true);
		}
		if (status != MMWLAN_SUCCESS) {
			(void)mmdrv_set_wake_enabled(true);
		}
	} else {
		status = mmdrv_set_wake_enabled(true);
		if (status == MMWLAN_SUCCESS) {
			status = mmdrv_set_chip_power_save_enabled(
				mesh_runtime.umac.vif_id, false);
		}
	}

	if (status != MMWLAN_SUCCESS) {
		LOG_ERR("could not %s mesh power save: status=%d vif=%u",
			enabled ? "enable" : "disable", status,
			mesh_runtime.umac.vif_id);
		return false;
	}
	return true;
}

static void sample_busy(void)
{
	if (mmhal_wlan_busy_is_asserted()) {
		mesh_ps_busy_samples++;
	}
	mesh_ps_total_samples++;
}

static void mesh_power_save_tick(uint32_t now)
{
	const bool connected = has_established_peer();

	if (!connected) {
		if (mesh_ps_phase == MESH_PS_ENABLED) {
			LOG_WRN("peer lost during power save; disabling PS");
			(void)set_mesh_power_save(false);
		} else if (mesh_ps_phase != MESH_PS_WAITING) {
			LOG_WRN("peer lost before power-save measurement completed");
		}
		mesh_ps_phase = MESH_PS_WAITING;
		return;
	}

	switch (mesh_ps_phase) {
	case MESH_PS_WAITING:
		LOG_INF("peer established; starting nRF54/MM6108 power-save A/B cycle");
		if (set_mesh_power_save(false)) {
			mesh_ps_phase = MESH_PS_SETTLING;
			mesh_ps_phase_started = now;
		}
		break;
	case MESH_PS_SETTLING:
		if ((uint32_t)(now - mesh_ps_phase_started) >= EDGEZ_PS_SETTLE_MS) {
			LOG_INF("BASELINE START: PS disabled for 30 seconds");
			reset_samples(now);
			mesh_ps_phase = MESH_PS_BASELINE;
		}
		break;
	case MESH_PS_BASELINE:
		sample_busy();
		if ((uint32_t)(now - mesh_ps_phase_started) >= EDGEZ_PS_BASELINE_MS) {
			mesh_ps_baseline_x10 = busy_percent_x10();
			LOG_INF("BASELINE END: MM_BUSY %u/%u samples (%u.%u%%), link=up",
				mesh_ps_busy_samples, mesh_ps_total_samples,
				mesh_ps_baseline_x10 / 10U,
				mesh_ps_baseline_x10 % 10U);
			enum mmwlan_status status = mmdrv_set_dynamic_ps_timeout(
				EDGEZ_PS_DYNAMIC_TIMEOUT_MS);
			if (status != MMWLAN_SUCCESS || !set_mesh_power_save(true)) {
				LOG_ERR("power-save transition failed: timeout_status=%d",
					status);
				mesh_ps_phase = MESH_PS_WAITING;
				break;
			}
			LOG_INF("POWER SAVE ENABLED: timeout=100 ms; reporting every 30 seconds");
			reset_samples(now);
			mesh_ps_phase = MESH_PS_ENABLED;
		}
		break;
	case MESH_PS_ENABLED:
		sample_busy();
		if ((uint32_t)(now - mesh_ps_phase_started) >= EDGEZ_PS_REPORT_MS) {
			const uint32_t power_save_x10 = busy_percent_x10();
			const int32_t change_x10 =
				(int32_t)power_save_x10 - (int32_t)mesh_ps_baseline_x10;
			const uint32_t magnitude_x10 =
				(uint32_t)(change_x10 < 0 ? -change_x10 : change_x10);
			LOG_INF("POWER SAVE: MM_BUSY %u/%u samples (%u.%u%%), link=up",
				mesh_ps_busy_samples, mesh_ps_total_samples,
				power_save_x10 / 10U, power_save_x10 % 10U);
			LOG_INF("BUSY duty change from baseline: %c%u.%u percentage points",
				change_x10 < 0 ? '-' : '+', magnitude_x10 / 10U,
				magnitude_x10 % 10U);
			reset_samples(now);
		}
		break;
	}
}
#endif

static void report_peers(void)
{
	size_t active = 0U;
	size_t established = 0U;
	size_t authorized = 0U;

	for (size_t i = 0; i < EDGEZ_UMAC_MAX_PEERS; ++i) {
		const struct edgez_mesh_peering_slot *slot =
			&mesh_runtime.peering_manager.slots[i];
		if (!slot->in_use) {
			continue;
		}
		active++;
		if (slot->peering.state == EDGEZ_PEERING_ESTABLISHED) {
			established++;
		}
		LOG_INF("peer %02x:%02x:%02x:%02x:%02x:%02x state=%s retries=%u",
			slot->peering.peer_addr[0], slot->peering.peer_addr[1],
			slot->peering.peer_addr[2], slot->peering.peer_addr[3],
			slot->peering.peer_addr[4], slot->peering.peer_addr[5],
			peering_state_name(slot->peering.state), slot->peering.retries);
	}
	for (size_t i = 0; i < EDGEZ_UMAC_MAX_PEERS; ++i) {
		const struct edgez_umac_peer *peer = &mesh_runtime.umac.peers[i];
		if (!peer->in_use) {
			continue;
		}
		if (peer->state == EDGEZ_UMAC_PEER_AUTHORIZED) {
			authorized++;
		}
		LOG_INF("radio peer %02x:%02x:%02x:%02x:%02x:%02x aid=%u state=%u",
			peer->mac_addr[0], peer->mac_addr[1], peer->mac_addr[2],
			peer->mac_addr[3], peer->mac_addr[4], peer->mac_addr[5],
			peer->aid, (unsigned)peer->state);
	}

	LOG_INF("join-only peers=%u established=%u authorized=%u rx=%" PRIu32
		" beacon=%" PRIu32 " auth=%" PRIu32 " mpm=%" PRIu32
		" malformed=%" PRIu32 " handler_fail=%" PRIu32
		" rejected=%" PRIu32 " state_err=%" PRIu32
		" transitions=%" PRIu32 " op_fail=%" PRIu32
		" tx=%" PRIu32 " tx_fail=%" PRIu32
		" bat_tx=%" PRIu32 " bat_fail=%" PRIu32 " driver=%d",
		(unsigned)active, (unsigned)established, (unsigned)authorized,
		mesh_runtime.rx_pipeline.metrics.received,
		mesh_runtime.rx_pipeline.metrics.beacons,
		mesh_runtime.rx_pipeline.metrics.authentications,
		mesh_runtime.rx_pipeline.metrics.peering_actions,
		mesh_runtime.rx_pipeline.metrics.malformed,
		mesh_runtime.rx_pipeline.metrics.handler_failures,
		mesh_runtime.controller.metrics.rejected_security_frames,
		mesh_runtime.controller.metrics.state_errors,
		mesh_runtime.peering_manager.transitions,
		mesh_runtime.peering_manager.operation_failures,
		tx_status_count, tx_failure_count,
		batman_tx_count, batman_tx_failure_count,
		mesh_runtime.umac.last_driver_status);

	if (mesh_runtime.peering_manager.operation_failures !=
	    previous_operation_failures) {
		LOG_WRN("peering operation failure delta=%" PRIu32
			" total=%" PRIu32 " last_driver=%d",
			mesh_runtime.peering_manager.operation_failures -
				previous_operation_failures,
			mesh_runtime.peering_manager.operation_failures,
			mesh_runtime.umac.last_driver_status);
		previous_operation_failures =
			mesh_runtime.peering_manager.operation_failures;
	}
	if (mesh_runtime.rx_pipeline.metrics.handler_failures !=
	    previous_handler_failures) {
		LOG_WRN("RX handler failure delta=%" PRIu32 " total=%" PRIu32,
			mesh_runtime.rx_pipeline.metrics.handler_failures -
				previous_handler_failures,
			mesh_runtime.rx_pipeline.metrics.handler_failures);
		previous_handler_failures =
			mesh_runtime.rx_pipeline.metrics.handler_failures;
	}
}

static int stop_mesh_profile(bool clear_routes)
{
	int status;

	if (!mesh_started) {
		return EDGEZ_UMAC_OK;
	}
	if (clear_routes && mesh_services_initialized && !sensor_radio_only) {
		(void)edgez_nrf_mesh_reset_and_pause();
		edgez_nrf_relay_reset();
	}
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
	(void)set_mesh_power_save(false);
	mesh_ps_phase = MESH_PS_WAITING;
#endif
	status = edgez_umac_mesh_runtime_stop(&mesh_runtime);
	if (status != EDGEZ_UMAC_OK) {
		/* runtime_stop leaves the UMAC in STOPPED state even when a driver
		 * cleanup operation reports an error. Finish local cleanup so a sleepy
		 * device can cut the rail and start from a clean runtime next cycle. */
		LOG_WRN("mesh runtime stop completed with driver error: %d", status);
	}
	edgez_rf_unbind_umac();
	if (mesh_secure) {
		edgez_mesh_sae_provider_deinit(&sae_provider);
	}
	memset(&mesh_runtime, 0, sizeof(mesh_runtime));
	memset(&sae_provider, 0, sizeof(sae_provider));
	open_data_sequence = 0;
	open_mesh_sequence = 0;
	open_tx_token = 0;
	mesh_secure = false;
	sensor_radio_only = false;
	mesh_started = false;
	edgez_config_set_halow_ready(false);
	edgez_config_set_halow_link(false);
	return EDGEZ_UMAC_OK;
}

static int start_mesh_profile(const struct edgez_halow_profile *profile,
			      bool reconfigure)
{
	size_t mesh_id_length = strlen(profile->mesh_id);
	size_t passphrase_length = strlen(profile->passphrase);
	size_t old_peer_count = 0;
	bool secure = passphrase_length > 0;
	const uint32_t control_interval_ms =
		edgez_mesh_country_control_interval_ms(profile->country_code, 1000U);
	int status;

	if (mesh_id_length == 0 || mesh_id_length > 32 ||
	    strlen(profile->country_code) != 2 || profile->mesh_frequency_khz == 0 ||
	    profile->mesh_bandwidth_mhz == 0) return EDGEZ_UMAC_INVALID_ARGUMENT;
	if (reconfigure && mesh_started) {
		old_peer_count = edgez_umac_peer_count(&mesh_runtime.umac);
		status = stop_mesh_profile(true);
		if (status != EDGEZ_UMAC_OK) {
			return status;
		}
		LOG_INF("Profile switch disconnected %u peer(s) and cleared BATMAN routes",
			(unsigned int)old_peer_count);
	}

	struct edgez_umac_mesh_runtime_config config = {
		.radio = edgez_rf_driver_ops(),
		.channel = {
			.operating_frequency_hz = profile->mesh_frequency_khz * 1000U,
			.operating_bw_mhz = profile->mesh_bandwidth_mhz,
			.primary_bw_mhz = EDGEZ_MESH_PRIMARY_BANDWIDTH_MHZ,
			.primary_1mhz_channel_index = 0U,
		},
		.mesh_id_length = mesh_id_length,
		.beacon_interval_tu = edgez_mesh_country_beacon_interval_tu(
			profile->country_code, EDGEZ_MESH_BEACON_INTERVAL_TU),
		.compressed_ssid = compressed_ssid((const uint8_t *)profile->mesh_id,
						  mesh_id_length),
		.mcs = 0U,
		.attempts = 2U,
		.peer_liveness_timeout_ms =
			edgez_mesh_control_liveness_timeout_ms(
				control_interval_ms,
				EDGEZ_UMAC_MESH_PEER_LIVENESS_TIMEOUT_MS),
		.rate_control = {
			.enabled = true,
			.initial_mcs = 0U,
			.maximum_mcs = 7U,
			.successes_to_increase = 4U,
		},
		.secure = secure,
		.events = join_events,
	};
	memcpy(config.country_code, profile->country_code, 2);
	config.country_code[2] = '\0';
	memcpy(config.mesh_id, profile->mesh_id, mesh_id_length);

	const struct edgez_mesh_sae_provider_config security_config = {
		.umac = &mesh_runtime.umac,
		.password = (const uint8_t *)profile->passphrase,
		.password_length = passphrase_length,
		.mesh_id = (const uint8_t *)profile->mesh_id,
		.mesh_id_length = mesh_id_length,
		.mcs = config.mcs,
		.attempts = config.attempts,
		.bandwidth_mhz = config.channel.operating_bw_mhz,
	};

	status = EDGEZ_UMAC_OK;
	if (secure) {
		status = edgez_mesh_sae_provider_init(&sae_provider, &security_config);
		if (status != EDGEZ_UMAC_OK) LOG_ERR("SAE provider init failed: %d", status);
	}
	if (status == EDGEZ_UMAC_OK && secure) {
		config.security = edgez_mesh_sae_provider_ops();
		config.security_ctx = &sae_provider;
	}
	if (status == EDGEZ_UMAC_OK) status = edgez_umac_mesh_runtime_init(&mesh_runtime, &config);
	if (status == EDGEZ_UMAC_OK) {
		status = edgez_rf_bind_umac(&mesh_runtime.umac);
		if (status != EDGEZ_UMAC_OK) {
			LOG_ERR("Morse RF callback bind failed: %d", status);
		}
	}
	if (status == EDGEZ_UMAC_OK) {
		status = edgez_umac_mesh_runtime_start(&mesh_runtime);
		if (status != EDGEZ_UMAC_OK) {
			LOG_ERR("mesh runtime start failed: %d driver=%d",
				status, mesh_runtime.umac.last_driver_status);
		}
	}
	if (status != EDGEZ_UMAC_OK) {
		LOG_ERR("join-only mesh start failed: edgez=%d driver=%d",
			status, mesh_runtime.umac.last_driver_status);
		if (mesh_runtime.running) {
			(void)edgez_umac_mesh_runtime_stop(&mesh_runtime);
		}
		edgez_rf_unbind_umac();
		if (secure) {
			edgez_mesh_sae_provider_deinit(&sae_provider);
		}
		memset(&mesh_runtime, 0, sizeof(mesh_runtime));
		memset(&sae_provider, 0, sizeof(sae_provider));
		return status;
	}

	if (secure) {
		edgez_mesh_sae_provider_set_local_address(
			&sae_provider, mesh_runtime.radio_info.mac_addr);
	}
	mesh_secure = secure;
	sensor_radio_only = false;
	mesh_started = true;
	applied_profile = *profile;
	if (!mesh_services_initialized) {
		status = edgez_nrf_mesh_init(mesh_runtime.radio_info.mac_addr,
					     &batman_transport,
					     control_interval_ms);
		if (status == 0) status = edgez_nrf_relay_init(mesh_runtime.radio_info.mac_addr);
		if (status != 0) {
			(void)stop_mesh_profile(false);
			return status;
		}
		mesh_services_initialized = true;
	} else {
		edgez_nrf_mesh_resume();
	}
	applied_generation = edgez_config_generation();
	edgez_config_set_halow_mac(mesh_runtime.radio_info.mac_addr);
	edgez_config_set_halow_ready(true);
	edgez_config_set_halow_link(has_established_peer());
	LOG_INF("mesh active id=%s security=%s country=%s frequency=%u kHz bandwidth=%u MHz generation=%u",
		profile->mesh_id, secure ? "SAE" : "open", profile->country_code,
		profile->mesh_frequency_khz, profile->mesh_bandwidth_mhz,
		applied_generation);
	LOG_INF("mesh control beacon=%u TU BATMAN=%u ms liveness=%u ms",
		config.beacon_interval_tu, control_interval_ms,
		config.peer_liveness_timeout_ms);
	LOG_INF("radio backend=%s chip=0x%08" PRIx32
		" vif=%u mac=%02x:%02x:%02x:%02x:%02x:%02x",
		mesh_runtime.umac.driver->name, mesh_runtime.radio_info.chip_id,
		mesh_runtime.umac.vif_id,
		mesh_runtime.radio_info.mac_addr[0], mesh_runtime.radio_info.mac_addr[1],
		mesh_runtime.radio_info.mac_addr[2], mesh_runtime.radio_info.mac_addr[3],
		mesh_runtime.radio_info.mac_addr[4], mesh_runtime.radio_info.mac_addr[5]);
	return EDGEZ_UMAC_OK;
}

static int start_sensor_radio(const struct edgez_halow_profile *profile)
{
	size_t mesh_id_length = strlen(profile->mesh_id);
	int status;

	if (mesh_id_length == 0U || mesh_id_length > 32U ||
	    strlen(profile->country_code) != 2U ||
	    profile->mesh_frequency_khz == 0U ||
	    profile->mesh_bandwidth_mhz == 0U) {
		return EDGEZ_UMAC_INVALID_ARGUMENT;
	}

	struct edgez_umac_mesh_runtime_config config = {
		.radio = edgez_rf_driver_ops(),
		.channel = {
			.operating_frequency_hz = profile->mesh_frequency_khz * 1000U,
			.operating_bw_mhz = profile->mesh_bandwidth_mhz,
			.primary_bw_mhz = EDGEZ_MESH_PRIMARY_BANDWIDTH_MHZ,
			.primary_1mhz_channel_index = 0U,
		},
		.mesh_id_length = mesh_id_length,
		.beacon_interval_tu = edgez_mesh_country_beacon_interval_tu(
			profile->country_code, EDGEZ_MESH_BEACON_INTERVAL_TU),
		.compressed_ssid = compressed_ssid((const uint8_t *)profile->mesh_id,
						  mesh_id_length),
		.mcs = 0U,
		.attempts = 2U,
		.rate_control = {
			.enabled = true,
			.initial_mcs = 0U,
			.maximum_mcs = 2U,
			.successes_to_increase = 4U,
		},
		.secure = false,
		.events = join_events,
	};
	memcpy(config.country_code, profile->country_code, 2U);
	config.country_code[2] = '\0';
	memcpy(config.mesh_id, profile->mesh_id, mesh_id_length);

	status = edgez_umac_mesh_runtime_init(&mesh_runtime, &config);
	if (status == EDGEZ_UMAC_OK) {
		status = edgez_rf_bind_umac(&mesh_runtime.umac);
	}
	if (status == EDGEZ_UMAC_OK) {
		const struct edgez_umac_config radio_config = {
			.country_code = {
				profile->country_code[0], profile->country_code[1], '\0'
			},
			.channel = config.channel,
			.beacon_interval_tu = config.beacon_interval_tu,
			.dtim_period = 1U,
			.compressed_ssid = config.compressed_ssid,
			.rate_control = config.rate_control,
			.enable_beaconing = false,
		};
		status = edgez_umac_start(&mesh_runtime.umac, &radio_config,
					 &mesh_runtime.radio_info);
	}
	if (status != EDGEZ_UMAC_OK) {
		LOG_ERR("PAwR-only radio start failed edgez=%d driver=%d", status,
			mesh_runtime.umac.last_driver_status);
		edgez_rf_unbind_umac();
		memset(&mesh_runtime, 0, sizeof(mesh_runtime));
		return status;
	}

	/* runtime_init installed the receive dispatcher. Mark it running so the
	 * vendor-action callback is accepted, but deliberately skip the mesh
	 * runtime start that enables beacons and peer discovery. */
	mesh_runtime.running = true;
	mesh_started = true;
	mesh_secure = false;
	sensor_radio_only = true;
	applied_profile = *profile;
	applied_generation = edgez_config_generation();
	edgez_config_set_halow_mac(mesh_runtime.radio_info.mac_addr);
	edgez_config_set_halow_ready(true);
	edgez_config_set_halow_link(false);
	LOG_INF("PAwR-only radio active beaconing=0 peering=0 country=%s frequency=%u kHz bandwidth=%u MHz",
		profile->country_code, profile->mesh_frequency_khz,
		profile->mesh_bandwidth_mhz);
	return EDGEZ_UMAC_OK;
}

enum sensor_power_phase {
	SENSOR_POWER_INACTIVE,
	SENSOR_POWER_READY,
	SENSOR_POWER_WAITING_GPS,
	SENSOR_POWER_TRANSMIT,
	SENSOR_POWER_SLEEPING,
};

static struct {
	enum sensor_power_phase phase;
	uint32_t generation;
	uint32_t cycle_started_ms;
	uint32_t next_wake_ms;
	uint32_t gps_deadline_ms;
} sensor_power;

static void sensor_begin_cycle(uint32_t now)
{
	sensor_power.cycle_started_ms = now;
	sensor_power.phase = SENSOR_POWER_READY;
}

static void sensor_enter(const struct edgez_halow_profile *profile, uint32_t now)
{
	edgez_ble_stop();
	/* Begin with GPS and its UART off. The power build wakes them only inside
	 * the bounded reporting window and stops them again before tickless sleep. */
	edgez_gps_stop();
	if (mesh_started) {
		int rc = stop_mesh_profile(true);

		if (rc != EDGEZ_UMAC_OK) {
			LOG_WRN("sensor mode could not stop the active mesh rc=%d", rc);
		}
	}
	if (!mesh_started && edgez_halow_power_is_ready()) {
		int rc = edgez_halow_power_set(false);

		if (rc != 0 && rc != -ENOTSUP) {
			LOG_WRN("initial sensor HaLow power-off failed rc=%d", rc);
		}
	}
	sensor_power.generation = edgez_config_generation();
	sensor_begin_cycle(now);
	LOG_INF("low-power sensor mode armed device_type=%u update_interval=%us GPS=%s IMU=hardware-FIFO",
		profile->device_type, EDGEZ_SENSOR_UPDATE_INTERVAL_MS / 1000U,
		IS_ENABLED(CONFIG_OFFGRID_NRF54_SENSOR_GPS) ? "cycled" : "disabled");
}

static void sensor_leave(void)
{
	edgez_gps_stop();
	sensor_power.phase = SENSOR_POWER_INACTIVE;
	sensor_power.generation = 0U;
	if (!edgez_halow_power_is_ready()) {
		int rc = edgez_halow_power_set(true);

		if (rc != 0) {
			LOG_ERR("could not restore HaLow power after sensor mode rc=%d", rc);
		}
	}
	LOG_INF("low-power sensor mode disabled; restoring persistent mesh mode");
}

static void sensor_finish_cycle(uint32_t now)
{
	uint32_t elapsed_ms = now - sensor_power.cycle_started_ms;

	edgez_gps_stop();
	sensor_power.next_wake_ms = elapsed_ms < EDGEZ_SENSOR_UPDATE_INTERVAL_MS ?
		sensor_power.cycle_started_ms + EDGEZ_SENSOR_UPDATE_INTERVAL_MS : now + 1000U;
	sensor_power.phase = SENSOR_POWER_SLEEPING;
	LOG_INF("sensor cycle complete; HaLow off for %u ms",
		(unsigned)(sensor_power.next_wake_ms - now));
}

static void sensor_power_tick(const struct edgez_halow_profile *profile,
			      uint32_t now)
{
	if (sensor_power.phase == SENSOR_POWER_INACTIVE) {
		sensor_enter(profile, now);
	}
	if (sensor_power.generation != edgez_config_generation()) {
		edgez_gps_stop();
		if (mesh_started) {
			(void)stop_mesh_profile(true);
		}
		if (edgez_halow_power_is_ready()) {
			(void)edgez_halow_power_set(false);
		}
		sensor_power.generation = edgez_config_generation();
		sensor_begin_cycle(k_uptime_get_32());
		LOG_INF("sensor profile changed; restarting wake cycle generation=%u",
			sensor_power.generation);
		return;
	}

	if (sensor_power.phase == SENSOR_POWER_SLEEPING) {
		if ((int32_t)(now - sensor_power.next_wake_ms) >= 0) {
			sensor_begin_cycle(now);
		}
		return;
	}
	if (sensor_power.phase == SENSOR_POWER_READY) {
#if defined(CONFIG_OFFGRID_NRF54_SENSOR_GPS)
		int gps_rc = edgez_gps_init();

		if (gps_rc == 0) {
			sensor_power.gps_deadline_ms = now + EDGEZ_SENSOR_GPS_TIMEOUT_MS;
			sensor_power.phase = SENSOR_POWER_WAITING_GPS;
			LOG_INF("sensor GPS awake; waiting up to %u ms for fix",
				EDGEZ_SENSOR_GPS_TIMEOUT_MS);
			return;
		}
		LOG_WRN("sensor GPS wake failed rc=%d; sending without location", gps_rc);
#endif
		sensor_power.phase = SENSOR_POWER_TRANSMIT;
	}
	if (sensor_power.phase == SENSOR_POWER_WAITING_GPS) {
		struct edgez_gps_fix fix;

		edgez_gps_poll();
		if (edgez_gps_get_fix(&fix)) {
			LOG_INF("sensor GPS fix ready lat=%.6f lon=%.6f satellites=%u",
				(double)fix.latitude, (double)fix.longitude, fix.satellites);
			sensor_power.phase = SENSOR_POWER_TRANSMIT;
		} else if ((int32_t)(now - sensor_power.gps_deadline_ms) >= 0) {
			LOG_WRN("sensor GPS fix timeout after %u ms; sending without location",
				EDGEZ_SENSOR_GPS_TIMEOUT_MS);
			sensor_power.phase = SENSOR_POWER_TRANSMIT;
		} else {
			return;
		}
	}
	if (sensor_power.phase != SENSOR_POWER_TRANSMIT) {
		return;
	}

	/* The reporting timer is the only periodic MCU wake source in the power
	 * build. Collect the samples accumulated by the IMU hardware FIFO before
	 * powering HaLow, so IMU traffic cannot overlap radio startup or TX. */
	int imu_rc = edgez_imu_drain_fifo();
	if (imu_rc != 0 && imu_rc != -ENOTSUP && imu_rc != -EAGAIN) {
		LOG_WRN("sensor timer-wake IMU FIFO drain failed rc=%d", imu_rc);
	}

	int rc = 0;
	if (!mesh_started && !edgez_halow_power_is_ready()) {
		rc = edgez_halow_power_set(true);
	}
	if (rc == 0 && !mesh_started) {
		rc = start_sensor_radio(profile);
	}
	if (rc != EDGEZ_UMAC_OK) {
		LOG_ERR("sensor HaLow wake failed rc=%d; retrying next cycle", rc);
	} else {
		/* Radio startup is synchronous. A short settle gives the connectionless
		 * vendor-action receive callback time to arm; no mesh tick, beacon, scan,
		 * or peering operation is run in sensor mode. */
		k_msleep(100);
		bool acknowledged = false;

		for (unsigned attempt = 1U;
		     attempt <= EDGEZ_SENSOR_PAWR_ATTEMPTS; ++attempt) {
			rc = sensor_pawr_send_once(EDGEZ_SENSOR_UPDATE_INTERVAL_MS);
			if (rc == 0) {
				acknowledged = true;
				break;
			}
			LOG_WRN("sensor PAwR attempt %u/%u failed rc=%d", attempt,
				EDGEZ_SENSOR_PAWR_ATTEMPTS, rc);
			if (attempt < EDGEZ_SENSOR_PAWR_ATTEMPTS) {
				k_msleep(EDGEZ_SENSOR_RETRY_DELAY_MS);
			}
		}
		LOG_INF("sensor telemetry %s after PAwR attempts",
			acknowledged ? "acknowledged" : "unacknowledged");
		int stop_rc = stop_mesh_profile(true);

		if (stop_rc != EDGEZ_UMAC_OK) {
			LOG_WRN("sensor mesh shutdown reported rc=%d; forcing rail cutoff",
				stop_rc);
		}
	}
	if (!mesh_started && edgez_halow_power_is_ready()) {
		int power_rc = edgez_halow_power_set(false);

		if (power_rc != 0 && power_rc != -ENOTSUP) {
			LOG_WRN("sensor HaLow rail cutoff failed rc=%d", power_rc);
		}
	}
	int battery_rc = edgez_battery_refresh_async();
	if (battery_rc != 0 && battery_rc != -ENOTSUP &&
	    battery_rc != -EALREADY) {
		LOG_WRN("sensor battery refresh failed rc=%d", battery_rc);
	}
	sensor_finish_cycle(k_uptime_get_32());
}

int main(void)
{
#if EDGEZ_DIAGNOSTICS_ENABLED && !defined(EDGEZ_PLATFORM_ARCHIVE_BUILD)
	edgez_diagnostics_set_sink(join_diagnostic_sink, NULL);
	edgez_diagnostics_set_level(EDGEZ_DIAGNOSTIC_DEBUG);
#endif
	LOG_INF("EdgeZ nRF54 BLE + BATMAN application; IP services disabled");
	configure_user_button();
	int sensor_rc = edgez_battery_init();
	if (sensor_rc != 0) {
		LOG_WRN("battery sensing unavailable rc=%d", sensor_rc);
	}
	sensor_rc = edgez_imu_init();
	if (sensor_rc != 0) {
		LOG_WRN("IMU unavailable rc=%d; sensor beacons will omit motion", sensor_rc);
	} else {
		LOG_INF("IMU initialized for low-power sensor sampling");
	}
	edgez_config_init(CONFIG_WIFI_SSID, CONFIG_WIFI_PSK);
	livestock_config_init();
	if (edgez_ble_start() != 0) LOG_ERR("BLE control service failed to start");

	uint32_t next_report = k_uptime_get_32();
	uint32_t next_mesh_tick = next_report;
	uint32_t next_start_attempt = next_report;
	uint32_t next_beacon = next_report;
	uint32_t next_link_check = next_report;
	uint32_t next_ble_status = next_report;
	bool previous_link_up = false;
	while (true) {
		const uint32_t now = k_uptime_get_32();
		struct edgez_halow_profile profile = {0};
		edgez_config_get_profile(&profile);
		poll_user_button();
		const bool sensor_mode = edgez_config_should_autostart() &&
			profile_uses_sensor_mode(&profile);

		if (sensor_mode) {
			sensor_power_tick(&profile, now);
			edgez_ble_process();
			if (sensor_power.phase == SENSOR_POWER_SLEEPING) {
				if (!edgez_ble_is_stopped()) {
					/* Complete an asynchronous disconnect and controller
					 * shutdown before entering the long timer sleep. */
					k_msleep(20);
					continue;
				}
				const uint32_t sleep_now = k_uptime_get_32();
				const int32_t remaining_ms =
					(int32_t)(sensor_power.next_wake_ms - sleep_now);

				/* Zephyr's tickless idle puts the nRF54L15 to sleep until
				 * the next PAwR cycle or a hardware interrupt (including
				 * the IMU FIFO watermark interrupt). */
				k_msleep(remaining_ms > 0 ? remaining_ms : 1);
			} else {
				k_msleep(1);
			}
			continue;
		}
		if (sensor_power.phase != SENSOR_POWER_INACTIVE) {
			sensor_leave();
			next_start_attempt = k_uptime_get_32();
		}

		if (!mesh_started && edgez_config_should_autostart() &&
		    (int32_t)(now - next_start_attempt) >= 0) {
			next_start_attempt = now + 5000U;
			if (!edgez_halow_power_is_ready()) {
				LOG_WRN("HaLow profile ready, but the radio power rail is unavailable");
			} else if (start_mesh_profile(&profile, false) != EDGEZ_UMAC_OK) {
				LOG_ERR("HaLow profile start failed; retrying in 5 seconds");
			}
		}

		if (mesh_started && edgez_config_generation() != applied_generation) {
			if (same_radio_profile(&profile, &applied_profile)) {
				applied_profile = profile;
				applied_generation = edgez_config_generation();
				LOG_INF("Identity/beacon settings updated without resetting HaLow generation=%u",
					applied_generation);
			} else {
				edgez_config_set_halow_ready(false);
				if (start_mesh_profile(&profile, true) != EDGEZ_UMAC_OK) {
					LOG_ERR("HaLow profile reconfiguration failed");
				}
			}
		}

		if (mesh_started && (int32_t)(now - next_mesh_tick) >= 0) {
			edgez_umac_mesh_runtime_tick(&mesh_runtime, now);
			edgez_nrf_mesh_tick();
			edgez_nrf_relay_tick();
			next_mesh_tick = now + EDGEZ_MESH_TICK_MS;
		}
		if (mesh_started && (int32_t)(now - next_link_check) >= 0) {
			const bool link_up = has_established_peer();

			edgez_config_set_halow_link(link_up);
			if (link_up && !previous_link_up) {
				/* A boot-time beacon can be queued before a usable radio peer
				 * exists. Send a fresh identity beacon as soon as MPM finishes so
				 * the remote phone does not wait for the full profile interval. */
				next_beacon = now;
				LOG_INF("HaLow link established; scheduling immediate NetworkPacket beacon");
			}
			previous_link_up = link_up;
			next_link_check = now + 500U;
		}
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
		if (mesh_started) mesh_power_save_tick(now);
#endif
		if (mesh_started && (int32_t)(now - next_beacon) >= 0) {
			uint8_t beacon[512];
			size_t beacon_len = 0;
			uint32_t interval = MAX(profile.beacon_interval_seconds, 5U) * 1000U;
			if (!previous_link_up) {
				next_beacon = now + 1000U;
			} else if (edgez_config_build_network_beacon(mesh_runtime.radio_info.mac_addr,
							 beacon, sizeof(beacon), &beacon_len) == 0) {
				int rc = edgez_nrf_relay_send(NULL, beacon, beacon_len);
				if (rc == 0) {
					LOG_INF("NetworkPacket beacon queued bytes=%u",
						(unsigned int)beacon_len);
					next_beacon = now + interval;
				} else {
					LOG_WRN("NetworkPacket beacon queue failed rc=%d; retrying", rc);
					next_beacon = now + 3000U;
				}
			} else {
				LOG_WRN("NetworkPacket beacon build failed; retrying");
				next_beacon = now + 3000U;
			}
		}
		if ((int32_t)(now - next_ble_status) >= 0) {
			uint8_t status_packet[256];
			size_t status_len = 0;
			if (edgez_ble_is_connected() &&
			    edgez_config_build_status_packet(status_packet,
						     sizeof(status_packet), &status_len) == 0) {
				(void)edgez_ble_notify_packet(status_packet, status_len);
			}
			next_ble_status = now + 5000U;
		}
		if (mesh_started && (int32_t)(now - next_report) >= 0) {
			report_peers();
			LOG_INF("BATMAN routes=%u BLE=%s", (unsigned)edgez_nrf_mesh_route_count(),
				edgez_ble_is_connected() ? "connected" : "disconnected");
			next_report = now + EDGEZ_MESH_REPORT_MS;
		}
		k_msleep(
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
			EDGEZ_PS_SAMPLE_MS
#else
			EDGEZ_MESH_TICK_MS
#endif
		);
	}
}

#endif /* CONFIG_WIFI_MORSEMICRO_EDGEZ_JOIN_ONLY */
