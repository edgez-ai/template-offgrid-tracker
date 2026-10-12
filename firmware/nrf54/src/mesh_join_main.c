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

#include "edgez_diagnostics.h"
#include "edgez_mesh_sae_provider.h"
#include "edgez_rf_api.h"
#include "edgez_umac_mesh_runtime.h"
#include "edgez_reboot.h"

#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
#include "mmhal_wlan.h"
#include "mmwlan.h"

extern enum mmwlan_status mmdrv_set_wake_enabled(bool enabled);
extern enum mmwlan_status mmdrv_set_chip_power_save_enabled(uint16_t vif_id,
							     bool enabled);
extern enum mmwlan_status mmdrv_set_dynamic_ps_timeout(uint32_t timeout_ms);
#endif

LOG_MODULE_REGISTER(edgez_mesh_join, LOG_LEVEL_INF);

#define EDGEZ_MESH_ID "edgez"
#define EDGEZ_MESH_PASSPHRASE "edgez123"
#define EDGEZ_MESH_FREQUENCY_HZ 915000000U
#define EDGEZ_MESH_BANDWIDTH_MHZ 2U
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

static int join_drop_data(void *ctx, const struct edgez_umac_rx_frame *radio,
			  const struct edgez_mesh_rx_data *frame)
{
	ARG_UNUSED(ctx);
	ARG_UNUSED(radio);
	ARG_UNUSED(frame);
	return EDGEZ_UMAC_OK;
}

static int join_drop_protected_data(
	void *ctx, const struct edgez_umac_rx_frame *radio,
	const struct edgez_mesh_rx_protected_data *frame)
{
	ARG_UNUSED(ctx);
	ARG_UNUSED(radio);
	ARG_UNUSED(frame);
	return EDGEZ_UMAC_OK;
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
	.data = join_drop_data,
	.protected_data = join_drop_protected_data,
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

static int start_join_only_mesh(void)
{
	static const uint8_t mesh_id[] = EDGEZ_MESH_ID;
	static const uint8_t passphrase[] = EDGEZ_MESH_PASSPHRASE;
	struct edgez_umac_mesh_runtime_config config = {
		.radio = edgez_rf_driver_ops(),
		.country_code = "US",
		.channel = {
			.operating_frequency_hz = EDGEZ_MESH_FREQUENCY_HZ,
			.operating_bw_mhz = EDGEZ_MESH_BANDWIDTH_MHZ,
			.primary_bw_mhz = EDGEZ_MESH_PRIMARY_BANDWIDTH_MHZ,
			.primary_1mhz_channel_index = 0U,
		},
		.mesh_id_length = sizeof(mesh_id) - 1U,
		.beacon_interval_tu = EDGEZ_MESH_BEACON_INTERVAL_TU,
		.compressed_ssid = 0x4544475aU,
		.mcs = 0U,
		.attempts = 2U,
		.rate_control = {
			.enabled = true,
			.initial_mcs = 0U,
			.maximum_mcs = 7U,
			.successes_to_increase = 4U,
		},
		.secure = true,
		.events = join_events,
	};
	memcpy(config.mesh_id, mesh_id, sizeof(mesh_id) - 1U);

	const struct edgez_mesh_sae_provider_config security_config = {
		.umac = &mesh_runtime.umac,
		.password = passphrase,
		.password_length = sizeof(passphrase) - 1U,
		.mesh_id = mesh_id,
		.mesh_id_length = sizeof(mesh_id) - 1U,
		.mcs = config.mcs,
		.attempts = config.attempts,
		.bandwidth_mhz = config.channel.operating_bw_mhz,
	};

	int status = edgez_mesh_sae_provider_init(&sae_provider, &security_config);
	if (status != EDGEZ_UMAC_OK) {
		LOG_ERR("SAE provider init failed: %d", status);
	}
	if (status == EDGEZ_UMAC_OK) {
		config.security = edgez_mesh_sae_provider_ops();
		config.security_ctx = &sae_provider;
		status = edgez_umac_mesh_runtime_init(&mesh_runtime, &config);
		if (status != EDGEZ_UMAC_OK) {
			LOG_ERR("mesh runtime init failed: %d", status);
		}
	}
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

	edgez_mesh_sae_provider_set_local_address(
		&sae_provider, mesh_runtime.radio_info.mac_addr);
	LOG_INF("join-only mesh active id=%s security=SAE country=US frequency=%u Hz bandwidth=%u MHz",
		EDGEZ_MESH_ID, EDGEZ_MESH_FREQUENCY_HZ,
		EDGEZ_MESH_BANDWIDTH_MHZ);
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
	LOG_INF("EdgeZ nRF54 join-only image; extender/IP services disabled");
	if (!edgez_halow_power_is_ready()) {
		LOG_ERR("HC01 power was not initialized before Morse device startup");
		return 0;
	}
	if (start_join_only_mesh() != EDGEZ_UMAC_OK) {
		return 0;
	}

	uint32_t next_report = k_uptime_get_32();
	uint32_t next_mesh_tick = next_report;
	while (true) {
		const uint32_t now = k_uptime_get_32();
		if ((int32_t)(now - next_mesh_tick) >= 0) {
			edgez_umac_mesh_runtime_tick(&mesh_runtime, now);
			next_mesh_tick = now + EDGEZ_MESH_TICK_MS;
		}
#if defined(CONFIG_OFFGRID_NRF54_MESH_PS_TEST)
		mesh_power_save_tick(now);
#endif
		if ((int32_t)(now - next_report) >= 0) {
			report_peers();
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
