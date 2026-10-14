#include "edgez_mesh_relay.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/random/random.h>
#include <zephyr/sys/byteorder.h>

#include "edgez_ble.h"
#include "edgez_mesh_zephyr.h"

LOG_MODULE_REGISTER(edgez_relay, LOG_LEVEL_INF);

#define RELAY_MAGIC 0x455a4d51U
#define RELAY_VERSION 1U
#define RELAY_TYPE_NETWORK_PACKET 5U
#define RELAY_KIND_NETWORK_PACKET 2U
#define RELAY_ETHERTYPE 0x88b5U
#define RELAY_ETH_HEADER_LEN 14U
#define RELAY_FRAME_LIMIT 480U
#define RELAY_PAYLOAD_LIMIT 512U
#define RELAY_ASSEMBLIES 2U

struct __packed relay_header {
	uint32_t magic;
	uint8_t version;
	uint8_t type;
	uint8_t qos;
	uint8_t flags;
	uint32_t message_id;
	uint32_t total_length;
	uint16_t fragment_offset;
	uint16_t fragment_length;
	uint16_t topic_length;
};

struct relay_assembly {
	bool used;
	uint8_t source[6];
	uint32_t message_id;
	uint16_t total_length;
	uint16_t received;
	int64_t updated_ms;
	uint8_t payload[RELAY_PAYLOAD_LIMIT + 1U];
};

K_MUTEX_DEFINE(relay_lock);
static struct relay_assembly assemblies[RELAY_ASSEMBLIES];
static uint8_t local_mac[6];
static bool initialized;

static struct relay_assembly *find_assembly(const uint8_t source[6],
					     uint32_t message_id,
					     uint16_t total_length)
{
	struct relay_assembly *slot = NULL;
	struct relay_assembly *oldest = &assemblies[0];

	for (size_t i = 0; i < ARRAY_SIZE(assemblies); ++i) {
		if (assemblies[i].used && assemblies[i].message_id == message_id &&
		    memcmp(assemblies[i].source, source, 6) == 0) return &assemblies[i];
		if (!assemblies[i].used && !slot) slot = &assemblies[i];
		if (assemblies[i].updated_ms < oldest->updated_ms) oldest = &assemblies[i];
	}
	if (!slot) slot = oldest;
	memset(slot, 0, sizeof(*slot));
	slot->used = true;
	slot->message_id = message_id;
	slot->total_length = total_length;
	slot->updated_ms = k_uptime_get();
	memcpy(slot->source, source, 6);
	return slot;
}

static void receive_relay(const uint8_t originator[6], const uint8_t *frame,
			  size_t frame_len, void *ctx)
{
	ARG_UNUSED(ctx);
	struct relay_header header;
	const uint8_t *data;
	size_t length;

	if (!frame || frame_len < RELAY_ETH_HEADER_LEN + sizeof(header) ||
	    sys_get_be16(frame + 12) != RELAY_ETHERTYPE) return;
	if (memcmp(frame, local_mac, 6) != 0 &&
	    memcmp(frame, (uint8_t[]){255,255,255,255,255,255}, 6) != 0) return;
	data = frame + RELAY_ETH_HEADER_LEN;
	length = frame_len - RELAY_ETH_HEADER_LEN;
	memcpy(&header, data, sizeof(header));
	if (header.magic != RELAY_MAGIC || header.version != RELAY_VERSION ||
	    header.type != RELAY_TYPE_NETWORK_PACKET || header.topic_length != 0 ||
	    header.total_length == 0 || header.total_length > RELAY_PAYLOAD_LIMIT + 1U ||
	    sizeof(header) + header.fragment_length != length ||
	    (uint32_t)header.fragment_offset + header.fragment_length > header.total_length) return;

	k_mutex_lock(&relay_lock, K_FOREVER);
	struct relay_assembly *item = find_assembly(originator, header.message_id,
						    (uint16_t)header.total_length);
	if (!item || item->received != header.fragment_offset) {
		k_mutex_unlock(&relay_lock);
		return;
	}
	memcpy(item->payload + header.fragment_offset, data + sizeof(header),
	       header.fragment_length);
	item->received += header.fragment_length;
	item->updated_ms = k_uptime_get();
	if (item->received == item->total_length) {
		if (item->payload[0] == RELAY_KIND_NETWORK_PACKET) {
			int rc = edgez_ble_notify_packet(item->payload + 1,
						      item->total_length - 1U);
			if (rc) LOG_WRN("Mesh packet could not be forwarded to BLE rc=%d", rc);
		}
		memset(item, 0, sizeof(*item));
	}
	k_mutex_unlock(&relay_lock);
}

int edgez_nrf_relay_init(const uint8_t mac[6])
{
	if (!mac) return -EINVAL;
	memcpy(local_mac, mac, 6);
	edgez_nrf_mesh_register_payload(receive_relay, NULL);
	initialized = true;
	return 0;
}

int edgez_nrf_relay_send(const uint8_t destination[6], const uint8_t *payload,
			 size_t payload_len)
{
	uint8_t relay_payload[RELAY_PAYLOAD_LIMIT + 1U];
	uint8_t frame[RELAY_ETH_HEADER_LEN + RELAY_FRAME_LIMIT];
	uint32_t message_id;
	size_t offset = 0;

	if (!initialized) return -EHOSTDOWN;
	if (!payload || payload_len == 0 || payload_len > RELAY_PAYLOAD_LIMIT) return -EINVAL;
	relay_payload[0] = RELAY_KIND_NETWORK_PACKET;
	memcpy(relay_payload + 1, payload, payload_len);
	message_id = sys_rand32_get();

	do {
		struct relay_header header = {
			.magic = RELAY_MAGIC, .version = RELAY_VERSION,
			.type = RELAY_TYPE_NETWORK_PACKET, .message_id = message_id,
			.total_length = payload_len + 1U, .fragment_offset = offset,
		};
		size_t remaining = payload_len + 1U - offset;
		size_t chunk = MIN(remaining, RELAY_FRAME_LIMIT - sizeof(header));
		header.fragment_length = chunk;
		if (destination) memcpy(frame, destination, 6);
		else memset(frame, 0xff, 6);
		memcpy(frame + 6, local_mac, 6);
		sys_put_be16(RELAY_ETHERTYPE, frame + 12);
		memcpy(frame + RELAY_ETH_HEADER_LEN, &header, sizeof(header));
		memcpy(frame + RELAY_ETH_HEADER_LEN + sizeof(header), relay_payload + offset, chunk);
		int rc = destination ?
			edgez_nrf_mesh_send_unicast(destination, frame,
				RELAY_ETH_HEADER_LEN + sizeof(header) + chunk) :
			edgez_nrf_mesh_send_broadcast(frame,
				RELAY_ETH_HEADER_LEN + sizeof(header) + chunk);
		if (rc) return rc;
		offset += chunk;
	} while (offset < payload_len + 1U);
	return 0;
}

void edgez_nrf_relay_reset(void)
{
	k_mutex_lock(&relay_lock, K_FOREVER);
	memset(assemblies, 0, sizeof(assemblies));
	k_mutex_unlock(&relay_lock);
}
