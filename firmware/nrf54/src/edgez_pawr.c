#include "edgez_pawr.h"

#include <errno.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "edgez_config.h"
#include "edgez_pawr_protocol.h"
#include "mmwlan.h"

LOG_MODULE_REGISTER(edgez_pawr, LOG_LEVEL_INF);

#define EDGEZ_PAWR_MAX_BEACON_LEN 250U
#define EDGEZ_PAWR_TX_READY_TIMEOUT_MS 250U

static const uint8_t edgez_pawr_oui[MMWLAN_OUI_SIZE] = {'E', 'd', 'g'};
static const uint8_t broadcast_mac[MMWLAN_MAC_ADDR_LEN] = {
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff
};

static struct k_spinlock state_lock;
static uint32_t next_request_id;
static uint32_t pending_beacon_hash;
static bool pending_response;
static bool initialized;
K_SEM_DEFINE(response_sem, 0, 1);

static void action_rx(const uint8_t source_mac[MMWLAN_MAC_ADDR_LEN],
		      const uint8_t *payload, size_t payload_len,
		      int16_t rssi_dbm, void *arg)
{
	uint32_t expected_hash;
	uint32_t response_hash;
	bool waiting;
	k_spinlock_key_t key;

	ARG_UNUSED(arg);
	if (!source_mac ||
	    !edgez_pawr_decode_response(payload, payload_len, &response_hash)) {
		return;
	}

	key = k_spin_lock(&state_lock);
	expected_hash = pending_beacon_hash;
	waiting = pending_response;
	if (waiting && response_hash == expected_hash) {
		pending_response = false;
	}
	k_spin_unlock(&state_lock, key);

	if (!waiting || response_hash != expected_hash) {
		LOG_WRN("stale Beacon response hash=%08x expected=%08x",
			response_hash, expected_hash);
		return;
	}

	LOG_INF("Beacon response hash=%08x from=%02x:%02x:%02x:%02x:%02x:%02x rssi=%ddBm",
		response_hash, source_mac[0], source_mac[1], source_mac[2],
		source_mac[3], source_mac[4], source_mac[5], rssi_dbm);
	k_sem_give(&response_sem);
}

int edgez_pawr_init(void)
{
	enum mmwlan_status status;

	if (initialized) {
		return 0;
	}
	status = mmwlan_register_vendor_action_rx_cb(edgez_pawr_oui, action_rx, NULL);
	if (status != MMWLAN_SUCCESS) {
		LOG_ERR("vendor action receiver registration failed status=%d", status);
		return -EIO;
	}
	initialized = true;
	LOG_INF("HaLow sleepy-device request client ready");
	return 0;
}

int edgez_pawr_send_beacon_request(uint32_t wake_interval_ms)
{
	uint8_t frame[EDGEZ_PAWR_HEADER_LENGTH + EDGEZ_PAWR_MAX_BEACON_LEN];
	enum mmwlan_status status;
	k_spinlock_key_t key;
	uint32_t hash;
	uint32_t request_id;
	size_t beacon_len = 0;
	size_t frame_len;

	if (edgez_config_copy_halow_beacon(frame + EDGEZ_PAWR_HEADER_LENGTH,
					 EDGEZ_PAWR_MAX_BEACON_LEN, &beacon_len) != 0) {
		LOG_WRN("Beacon request skipped: payload is not ready");
		return -EAGAIN;
	}

	/* The old caller delayed every request by a fixed 750 ms after the radio
	 * reported ready. Wait on the datapath itself instead so an already-ready
	 * sleepy mesh can transmit immediately. */
	status = mmwlan_tx_wait_until_ready(EDGEZ_PAWR_TX_READY_TIMEOUT_MS);
	if (status != MMWLAN_SUCCESS) {
		LOG_WRN("Beacon request TX path not ready status=%d", status);
		return status == MMWLAN_TIMED_OUT ? -EAGAIN : -EIO;
	}

	request_id = ++next_request_id;
	hash = edgez_pawr_payload_hash(frame + EDGEZ_PAWR_HEADER_LENGTH, beacon_len);
	if (!edgez_pawr_encode_request(frame, sizeof(frame), request_id,
				       wake_interval_ms,
				       frame + EDGEZ_PAWR_HEADER_LENGTH, beacon_len,
				       &frame_len)) {
		return -EMSGSIZE;
	}

	k_sem_reset(&response_sem);
	key = k_spin_lock(&state_lock);
	pending_beacon_hash = hash;
	pending_response = true;
	k_spin_unlock(&state_lock, key);

	status = mmwlan_send_vendor_action(broadcast_mac, edgez_pawr_oui, frame,
					   frame_len);
	if (status != MMWLAN_SUCCESS) {
		key = k_spin_lock(&state_lock);
		pending_response = false;
		k_spin_unlock(&state_lock, key);
		LOG_WRN("Beacon request=%u failed status=%d", request_id, status);
		return -EIO;
	}

	LOG_INF("Beacon request=%u queued payload=%u wake_interval=%ums hash=%08x",
		request_id, (unsigned int)beacon_len, wake_interval_ms, hash);
	return 0;
}

bool edgez_pawr_wait_for_response(uint32_t timeout_ms)
{
	bool received = k_sem_take(&response_sem, K_MSEC(timeout_ms)) == 0;
	k_spinlock_key_t key = k_spin_lock(&state_lock);

	pending_response = false;
	k_spin_unlock(&state_lock, key);
	return received;
}
