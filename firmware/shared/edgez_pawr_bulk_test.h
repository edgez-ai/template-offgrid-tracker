#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define EDGEZ_PAWR_BULK_MAGIC 0x455a4254U
#define EDGEZ_PAWR_BULK_VERSION 1U
#define EDGEZ_PAWR_BULK_HEADER_SIZE 32U
#define EDGEZ_PAWR_BULK_CHUNK_DATA_SIZE 1400U

#define EDGEZ_PAWR_BULK_FLAG_FIRST 0x01U
#define EDGEZ_PAWR_BULK_FLAG_LAST 0x02U

struct edgez_pawr_bulk_chunk {
	uint32_t session_id;
	uint32_t total_length;
	uint32_t offset;
	uint32_t expected_digest;
	uint16_t chunk_index;
	uint16_t chunk_count;
	uint16_t data_length;
	uint8_t test_index;
	uint8_t flags;
	const uint8_t *data;
};

static inline void edgez_pawr_bulk_put_u16(uint8_t *out, uint16_t value)
{
	out[0] = (uint8_t)(value >> 8U);
	out[1] = (uint8_t)value;
}

static inline void edgez_pawr_bulk_put_u32(uint8_t *out, uint32_t value)
{
	out[0] = (uint8_t)(value >> 24U);
	out[1] = (uint8_t)(value >> 16U);
	out[2] = (uint8_t)(value >> 8U);
	out[3] = (uint8_t)value;
}

static inline uint16_t edgez_pawr_bulk_get_u16(const uint8_t *in)
{
	return (uint16_t)(((uint16_t)in[0] << 8U) | in[1]);
}

static inline uint32_t edgez_pawr_bulk_get_u32(const uint8_t *in)
{
	return ((uint32_t)in[0] << 24U) | ((uint32_t)in[1] << 16U) |
	       ((uint32_t)in[2] << 8U) | in[3];
}

static inline uint8_t edgez_pawr_bulk_test_byte(uint8_t test_index,
						 uint32_t offset)
{
	return (uint8_t)((offset * 29U + (uint32_t)test_index * 71U + 0x5aU) &
			 0xffU);
}

static inline uint32_t edgez_pawr_bulk_digest_update(uint32_t digest,
						      const uint8_t *data,
						      size_t length)
{
	for (size_t i = 0; i < length; ++i) {
		digest ^= data[i];
		digest *= 16777619U;
	}
	return digest;
}

static inline uint32_t edgez_pawr_bulk_expected_digest(uint8_t test_index,
							uint32_t length)
{
	uint32_t digest = 2166136261U;

	for (uint32_t offset = 0; offset < length; ++offset) {
		const uint8_t value = edgez_pawr_bulk_test_byte(test_index, offset);

		digest = edgez_pawr_bulk_digest_update(digest, &value, 1U);
	}
	return digest;
}

static inline size_t edgez_pawr_bulk_encode(
	uint8_t *output, size_t capacity, const struct edgez_pawr_bulk_chunk *chunk)
{
	if (!output || !chunk || !chunk->data ||
	    chunk->data_length > EDGEZ_PAWR_BULK_CHUNK_DATA_SIZE ||
	    capacity < EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length) {
		return 0U;
	}

	edgez_pawr_bulk_put_u32(output, EDGEZ_PAWR_BULK_MAGIC);
	output[4] = EDGEZ_PAWR_BULK_VERSION;
	output[5] = chunk->flags;
	output[6] = chunk->test_index;
	output[7] = 0U;
	edgez_pawr_bulk_put_u32(output + 8, chunk->session_id);
	edgez_pawr_bulk_put_u32(output + 12, chunk->total_length);
	edgez_pawr_bulk_put_u32(output + 16, chunk->offset);
	edgez_pawr_bulk_put_u32(output + 20, chunk->expected_digest);
	edgez_pawr_bulk_put_u16(output + 24, chunk->chunk_index);
	edgez_pawr_bulk_put_u16(output + 26, chunk->chunk_count);
	edgez_pawr_bulk_put_u16(output + 28, chunk->data_length);
	edgez_pawr_bulk_put_u16(output + 30, 0U);
	memcpy(output + EDGEZ_PAWR_BULK_HEADER_SIZE, chunk->data,
	       chunk->data_length);
	return EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length;
}

static inline bool edgez_pawr_bulk_decode(const uint8_t *input, size_t length,
						  struct edgez_pawr_bulk_chunk *chunk)
{
	if (!input || !chunk || length < EDGEZ_PAWR_BULK_HEADER_SIZE ||
	    edgez_pawr_bulk_get_u32(input) != EDGEZ_PAWR_BULK_MAGIC ||
	    input[4] != EDGEZ_PAWR_BULK_VERSION) {
		return false;
	}

	memset(chunk, 0, sizeof(*chunk));
	chunk->flags = input[5];
	chunk->test_index = input[6];
	chunk->session_id = edgez_pawr_bulk_get_u32(input + 8);
	chunk->total_length = edgez_pawr_bulk_get_u32(input + 12);
	chunk->offset = edgez_pawr_bulk_get_u32(input + 16);
	chunk->expected_digest = edgez_pawr_bulk_get_u32(input + 20);
	chunk->chunk_index = edgez_pawr_bulk_get_u16(input + 24);
	chunk->chunk_count = edgez_pawr_bulk_get_u16(input + 26);
	chunk->data_length = edgez_pawr_bulk_get_u16(input + 28);
	chunk->data = input + EDGEZ_PAWR_BULK_HEADER_SIZE;

	return chunk->data_length <= EDGEZ_PAWR_BULK_CHUNK_DATA_SIZE &&
	       EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length == length &&
	       chunk->chunk_count > 0U && chunk->chunk_index < chunk->chunk_count &&
	       chunk->offset + chunk->data_length <= chunk->total_length;
}
