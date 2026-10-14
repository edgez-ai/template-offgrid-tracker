#include <zephyr/autoconf.h>

#if defined(CONFIG_WIFI_MORSEMICRO_EDGEZ_JOIN_ONLY)

/*
 * Copyright 2026 EdgeZeron AI AB
 * SPDX-License-Identifier: Apache-2.0
 */

#include <inttypes.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>

#include "edgez_diagnostics.h"
#include "edgez_batman_adv_lite.h"
#include "edgez_ble.h"
#include "edgez_config.h"
#include "edgez_mesh_data_frame.h"
#include "edgez_mesh_msdu.h"
#include "edgez_mesh_relay.h"
#include "edgez_mesh_zephyr.h"
#include "edgez_mesh_sae_provider.h"
#include "edgez_rf_api.h"
#include "edgez_umac_mesh_runtime.h"
#include "edgez_reboot.h"
#include "livestocking_config.h"

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
static uint32_t previous_operation_failures;
static uint32_t previous_handler_failures;
static uint32_t applied_generation;
static struct edgez_halow_profile applied_profile;
static bool mesh_started;
static bool mesh_secure;
static uint16_t open_data_sequence;
static uint32_t open_mesh_sequence;
static uintptr_t open_tx_token;
K_MUTEX_DEFINE(batman_state_lock);
K_MUTEX_DEFINE(batman_tx_lock);
#define EDGEZ_OPEN_DATA_FRAME_MAX (EDGEZ_MESH_QOS_4ADDR_HEADER_LEN + \
	EDGEZ_MESH_CONTROL_MAX_LEN + EDGEZ_RFC1042_HEADER_LEN + \
	EDGEZ_BATADV_MAX_PACKET_LEN)
static uint8_t open_data_frame[EDGEZ_OPEN_DATA_FRAME_MAX];

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
	ARG_UNUSED(radio);
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
	return rc == EDGEZ_UMAC_OK ? 0 : -EIO;
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

	LOG_INF("join-only peers=%u established=%u rx=%" PRIu32
		" beacon=%" PRIu32 " auth=%" PRIu32 " mpm=%" PRIu32
		" malformed=%" PRIu32 " handler_fail=%" PRIu32
		" rejected=%" PRIu32 " state_err=%" PRIu32
		" transitions=%" PRIu32 " op_fail=%" PRIu32
		" tx=%" PRIu32 " tx_fail=%" PRIu32 " driver=%d",
		(unsigned)active, (unsigned)established,
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

static int start_mesh_profile(const struct edgez_halow_profile *profile,
			      bool reconfigure)
{
	size_t mesh_id_length = strlen(profile->mesh_id);
	size_t passphrase_length = strlen(profile->passphrase);
	size_t old_peer_count = 0;
	bool secure = passphrase_length > 0;
	int status;

	if (mesh_id_length == 0 || mesh_id_length > 32 ||
	    strlen(profile->country_code) != 2 || profile->mesh_frequency_khz == 0 ||
	    profile->mesh_bandwidth_mhz == 0) return EDGEZ_UMAC_INVALID_ARGUMENT;
	if (reconfigure) {
		old_peer_count = edgez_umac_peer_count(&mesh_runtime.umac);
		(void)edgez_nrf_mesh_reset_and_pause();
		edgez_nrf_relay_reset();
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
		(void)set_mesh_power_save(false);
		mesh_ps_phase = MESH_PS_WAITING;
#endif
		status = edgez_umac_mesh_runtime_stop(&mesh_runtime);
		if (status != EDGEZ_UMAC_OK) {
			LOG_ERR("mesh runtime stop failed during profile switch: %d", status);
			return status;
		}
		edgez_rf_unbind_umac();
		edgez_mesh_sae_provider_deinit(&sae_provider);
		memset(&mesh_runtime, 0, sizeof(mesh_runtime));
		memset(&sae_provider, 0, sizeof(sae_provider));
		open_data_sequence = 0;
		open_mesh_sequence = 0;
		open_tx_token = 0;
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
		.beacon_interval_tu = EDGEZ_MESH_BEACON_INTERVAL_TU,
		.compressed_ssid = compressed_ssid((const uint8_t *)profile->mesh_id,
						  mesh_id_length),
		.mcs = 0U,
		.attempts = 2U,
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
		return status;
	}

	if (secure) {
		edgez_mesh_sae_provider_set_local_address(
			&sae_provider, mesh_runtime.radio_info.mac_addr);
	}
	mesh_secure = secure;
	applied_profile = *profile;
	if (!reconfigure) {
		status = edgez_nrf_mesh_init(mesh_runtime.radio_info.mac_addr,
					     &batman_transport, 1000U);
		if (status == 0) status = edgez_nrf_relay_init(mesh_runtime.radio_info.mac_addr);
		if (status != 0) return status;
	} else {
		edgez_nrf_mesh_resume();
	}
	mesh_started = true;
	applied_generation = edgez_config_generation();
	edgez_config_set_halow_mac(mesh_runtime.radio_info.mac_addr);
	edgez_config_set_halow_ready(true);
	edgez_config_set_halow_link(has_established_peer());
	LOG_INF("mesh active id=%s security=%s country=%s frequency=%u kHz bandwidth=%u MHz generation=%u",
		profile->mesh_id, secure ? "SAE" : "open", profile->country_code,
		profile->mesh_frequency_khz, profile->mesh_bandwidth_mhz,
		applied_generation);
	LOG_INF("radio backend=%s chip=0x%08" PRIx32
		" vif=%u mac=%02x:%02x:%02x:%02x:%02x:%02x",
		mesh_runtime.umac.driver->name, mesh_runtime.radio_info.chip_id,
		mesh_runtime.umac.vif_id,
		mesh_runtime.radio_info.mac_addr[0], mesh_runtime.radio_info.mac_addr[1],
		mesh_runtime.radio_info.mac_addr[2], mesh_runtime.radio_info.mac_addr[3],
		mesh_runtime.radio_info.mac_addr[4], mesh_runtime.radio_info.mac_addr[5]);
	return EDGEZ_UMAC_OK;
}

int main(void)
{
#if EDGEZ_DIAGNOSTICS_ENABLED && !defined(EDGEZ_PLATFORM_ARCHIVE_BUILD)
	edgez_diagnostics_set_sink(join_diagnostic_sink, NULL);
	edgez_diagnostics_set_level(EDGEZ_DIAGNOSTIC_DEBUG);
#endif
	LOG_INF("EdgeZ nRF54 BLE + BATMAN application; IP services disabled");
	edgez_config_init(CONFIG_WIFI_SSID, CONFIG_WIFI_PSK);
	livestock_config_init();
	if (edgez_ble_start() != 0) LOG_ERR("BLE control service failed to start");

	uint32_t next_report = k_uptime_get_32();
	uint32_t next_mesh_tick = next_report;
	uint32_t next_start_attempt = next_report;
	uint32_t next_beacon = next_report;
	uint32_t next_link_check = next_report;
	uint32_t next_ble_status = next_report;
	while (true) {
		const uint32_t now = k_uptime_get_32();
		struct edgez_halow_profile profile = {0};
		edgez_config_get_profile(&profile);

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
			next_mesh_tick = now + EDGEZ_MESH_TICK_MS;
		}
		if (mesh_started && (int32_t)(now - next_link_check) >= 0) {
			edgez_config_set_halow_link(has_established_peer());
			next_link_check = now + 500U;
		}
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
		if (mesh_started) mesh_power_save_tick(now);
#endif
		if (mesh_started && (int32_t)(now - next_beacon) >= 0) {
			uint8_t beacon[512];
			size_t beacon_len = 0;
			uint32_t interval = MAX(profile.beacon_interval_seconds, 5U) * 1000U;
			if (edgez_config_build_network_beacon(mesh_runtime.radio_info.mac_addr,
							 beacon, sizeof(beacon), &beacon_len) == 0) {
				int rc = edgez_nrf_relay_send(NULL, beacon, beacon_len);
				if (rc == 0) {
					LOG_INF("Periodic NetworkPacket beacon broadcast bytes=%u",
						(unsigned int)beacon_len);
					next_beacon = now + interval;
				} else {
					next_beacon = now + 3000U;
				}
			} else {
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
