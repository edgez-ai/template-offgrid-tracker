#include <assert.h>
#include <string.h>

#include "edgez_pawr_bulk_test.h"

struct receiver_window {
	struct edgez_pawr_bulk_control cached;
	bool active;
};

static bool receive_chunk(struct receiver_window *receiver,
			  const struct edgez_pawr_bulk_chunk *chunk)
{
	if (!receiver->active || chunk->window_id > receiver->cached.window_id) {
		receiver->active = true;
		receiver->cached = (struct edgez_pawr_bulk_control) {
			.kind = EDGEZ_PAWR_BULK_KIND_BLOCK_ACK,
			.session_id = chunk->session_id,
			.window_id = chunk->window_id,
			.base_chunk = chunk->window_base_chunk,
			.chunk_count = chunk->window_count,
			.test_index = chunk->test_index,
		};
	} else if (chunk->session_id != receiver->cached.session_id ||
		   chunk->window_id != receiver->cached.window_id ||
		   chunk->window_base_chunk != receiver->cached.base_chunk ||
		   chunk->window_count != receiver->cached.chunk_count) {
		return false;
	}
	receiver->cached.bitmap |= UINT32_C(1) <<
		(chunk->chunk_index - chunk->window_base_chunk);
	return true;
}

static void test_data_and_control_round_trip(void)
{
	uint8_t wire[EDGEZ_PAWR_BULK_HEADER_SIZE + 3U];
	const uint8_t data[] = {1U, 2U, 3U};
	const struct edgez_pawr_bulk_chunk input = {
		.session_id = 0x10203040U, .total_length = 9U, .offset = 3U,
		.expected_digest = 7U, .chunk_index = 11U, .chunk_count = 13U,
		.data_length = sizeof(data), .window_id = 4U,
		.window_base_chunk = 10U, .window_count = 3U, .test_index = 2U,
		.flags = EDGEZ_PAWR_BULK_FLAG_ACK_REQUEST, .data = data,
	};
	struct edgez_pawr_bulk_chunk output;
	assert(edgez_pawr_bulk_encode(wire, sizeof(wire), &input) == sizeof(wire));
	assert(edgez_pawr_bulk_decode(wire, sizeof(wire), &output));
	assert(output.session_id == input.session_id);
	assert(output.window_id == 4U && output.window_base_chunk == 10U);
	assert(output.window_count == 3U && output.chunk_index == 11U);
	assert(memcmp(output.data, data, sizeof(data)) == 0);

	uint8_t control_wire[EDGEZ_PAWR_BULK_CONTROL_SIZE];
	struct edgez_pawr_bulk_control control = {
		.kind = EDGEZ_PAWR_BULK_KIND_BLOCK_ACK,
		.session_id = input.session_id, .bitmap = 5U, .window_id = 4U,
		.base_chunk = 10U, .chunk_count = 3U, .test_index = 2U,
	};
	struct edgez_pawr_bulk_control decoded;
	assert(edgez_pawr_bulk_control_encode(control_wire, sizeof(control_wire),
					      &control) == sizeof(control_wire));
	assert(edgez_pawr_bulk_control_decode(control_wire, sizeof(control_wire),
					      &decoded));
	assert(decoded.bitmap == 5U);
	assert(edgez_pawr_bulk_control_matches(&decoded, input.session_id, 2U,
					       4U, 10U, 3U));
	assert(!edgez_pawr_bulk_control_matches(&decoded, input.session_id, 2U,
						5U, 10U, 3U));

	control_wire[17] = 1U;
	assert(!edgez_pawr_bulk_control_decode(control_wire, sizeof(control_wire),
					       &decoded));
	assert(!edgez_pawr_bulk_decode(wire, sizeof(wire) - 1U, &output));
}

static void test_partial_duplicate_selective_and_query_replay(void)
{
	struct receiver_window receiver = {0};
	uint8_t byte = 0U;
	struct edgez_pawr_bulk_chunk chunk = {
		.session_id = 9U, .total_length = 4U, .expected_digest = 1U,
		.chunk_count = 4U, .data_length = 1U, .window_id = 3U,
		.window_base_chunk = 20U, .window_count = 4U, .test_index = 1U,
		.data = &byte,
	};
	chunk.chunk_index = 20U;
	assert(receive_chunk(&receiver, &chunk));
	assert(receive_chunk(&receiver, &chunk)); /* duplicate is idempotent */
	chunk.chunk_index = 22U;
	assert(receive_chunk(&receiver, &chunk));
	assert(receiver.cached.bitmap == 0x5U);
	const uint32_t missing = 0xfU & ~receiver.cached.bitmap;
	assert(missing == 0xaU); /* selectively retransmit slots 1 and 3 */

	struct edgez_pawr_bulk_control query = receiver.cached;
	query.kind = EDGEZ_PAWR_BULK_KIND_ACK_QUERY;
	query.bitmap = 0U;
	assert(edgez_pawr_bulk_control_matches(
		&query, 9U, 1U, 3U, 20U, 4U));
	/* A lost ACK is recovered by replaying the cached bitmap, without data. */
	assert(receiver.cached.bitmap == 0x5U);

	chunk.chunk_index = 21U;
	assert(receive_chunk(&receiver, &chunk));
	chunk.chunk_index = 23U;
	assert(receive_chunk(&receiver, &chunk));
	assert(receiver.cached.bitmap == 0xfU);

	chunk.window_id = 2U;
	assert(!receive_chunk(&receiver, &chunk)); /* stale window */
	query.session_id++;
	assert(!edgez_pawr_bulk_control_matches(
		&query, 9U, 1U, 3U, 20U, 4U)); /* stale session response */
}

int main(void)
{
	test_data_and_control_round_trip();
	test_partial_duplicate_selective_and_query_replay();
	return 0;
}
