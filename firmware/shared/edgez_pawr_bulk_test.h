#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define EDGEZ_PAWR_BULK_MAGIC 0x455a4254U
#define EDGEZ_PAWR_BULK_VERSION 3U
#define EDGEZ_PAWR_BULK_HEADER_SIZE 48U
#define EDGEZ_PAWR_BULK_CHUNK_DATA_SIZE 1400U
#define EDGEZ_PAWR_BULK_CONTROL_SIZE 24U
#define EDGEZ_PAWR_BULK_MAX_WINDOW 32U

#define EDGEZ_PAWR_BULK_FLAG_FIRST 0x01U
#define EDGEZ_PAWR_BULK_FLAG_LAST 0x02U
#define EDGEZ_PAWR_BULK_FLAG_ACK_REQUEST 0x04U

enum edgez_pawr_bulk_kind {
	EDGEZ_PAWR_BULK_KIND_DATA = 1U,
	EDGEZ_PAWR_BULK_KIND_ACK_QUERY = 2U,
	EDGEZ_PAWR_BULK_KIND_BLOCK_ACK = 3U,
};

#define EDGEZ_PAWR_BULK_REG_FLAG_REGDB_VALID 0x01U
#define EDGEZ_PAWR_BULK_REG_FLAG_CHIP_DUTY_VALID 0x02U
#define EDGEZ_PAWR_BULK_REG_FLAG_TERMINAL_NODE 0x04U

struct edgez_pawr_bulk_regulatory {
	char country_code[3];
	uint32_t frequency_khz;
	uint16_t duty_cycle_centi_percent;
	int8_t max_eirp_dbm;
	uint8_t bandwidth_mhz;
	uint8_t duty_cycle_mode;
	uint8_t flags;
};

struct edgez_pawr_bulk_chunk {
	uint32_t session_id;
	uint32_t total_length;
	uint32_t offset;
	uint32_t expected_digest;
	uint16_t chunk_index;
	uint16_t chunk_count;
	uint16_t data_length;
	uint16_t window_id;
	uint16_t window_base_chunk;
	uint8_t window_count;
	uint8_t test_index;
	uint8_t flags;
	struct edgez_pawr_bulk_regulatory regulatory;
	const uint8_t *data;
};

struct edgez_pawr_bulk_control {
	enum edgez_pawr_bulk_kind kind;
	uint32_t session_id;
	uint32_t bitmap;
	uint16_t window_id;
	uint16_t base_chunk;
	uint8_t chunk_count;
	uint8_t test_index;
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
	    chunk->window_count == 0U ||
	    chunk->window_count > EDGEZ_PAWR_BULK_MAX_WINDOW ||
	    chunk->chunk_index < chunk->window_base_chunk ||
	    chunk->chunk_index - chunk->window_base_chunk >= chunk->window_count ||
	    capacity < EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length) {
		return 0U;
	}

	edgez_pawr_bulk_put_u32(output, EDGEZ_PAWR_BULK_MAGIC);
	output[4] = EDGEZ_PAWR_BULK_VERSION;
	output[5] = chunk->flags;
	output[6] = chunk->test_index;
	output[7] = EDGEZ_PAWR_BULK_KIND_DATA;
	edgez_pawr_bulk_put_u32(output + 8, chunk->session_id);
	edgez_pawr_bulk_put_u32(output + 12, chunk->total_length);
	edgez_pawr_bulk_put_u32(output + 16, chunk->offset);
	edgez_pawr_bulk_put_u32(output + 20, chunk->expected_digest);
	edgez_pawr_bulk_put_u16(output + 24, chunk->chunk_index);
	edgez_pawr_bulk_put_u16(output + 26, chunk->chunk_count);
	edgez_pawr_bulk_put_u16(output + 28, chunk->data_length);
	edgez_pawr_bulk_put_u16(output + 30,
		chunk->regulatory.duty_cycle_centi_percent);
	edgez_pawr_bulk_put_u32(output + 32,
		chunk->regulatory.frequency_khz);
	output[36] = (uint8_t)chunk->regulatory.country_code[0];
	output[37] = (uint8_t)chunk->regulatory.country_code[1];
	output[38] = chunk->regulatory.bandwidth_mhz;
	output[39] = (uint8_t)chunk->regulatory.max_eirp_dbm;
	output[40] = chunk->regulatory.duty_cycle_mode;
	output[41] = chunk->regulatory.flags;
	edgez_pawr_bulk_put_u16(output + 42, chunk->window_id);
	edgez_pawr_bulk_put_u16(output + 44, chunk->window_base_chunk);
	output[46] = chunk->window_count;
	output[47] = 0U;
	memcpy(output + EDGEZ_PAWR_BULK_HEADER_SIZE, chunk->data,
	       chunk->data_length);
	return EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length;
}

static inline bool edgez_pawr_bulk_decode(const uint8_t *input, size_t length,
						  struct edgez_pawr_bulk_chunk *chunk)
{
	if (!input || !chunk || length < EDGEZ_PAWR_BULK_HEADER_SIZE ||
	    edgez_pawr_bulk_get_u32(input) != EDGEZ_PAWR_BULK_MAGIC ||
	    input[4] != EDGEZ_PAWR_BULK_VERSION ||
	    input[7] != EDGEZ_PAWR_BULK_KIND_DATA) {
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
	chunk->window_id = edgez_pawr_bulk_get_u16(input + 42);
	chunk->window_base_chunk = edgez_pawr_bulk_get_u16(input + 44);
	chunk->window_count = input[46];
	chunk->regulatory.duty_cycle_centi_percent =
		edgez_pawr_bulk_get_u16(input + 30);
	chunk->regulatory.frequency_khz = edgez_pawr_bulk_get_u32(input + 32);
	chunk->regulatory.country_code[0] = (char)input[36];
	chunk->regulatory.country_code[1] = (char)input[37];
	chunk->regulatory.country_code[2] = '\0';
	chunk->regulatory.bandwidth_mhz = input[38];
	chunk->regulatory.max_eirp_dbm = (int8_t)input[39];
	chunk->regulatory.duty_cycle_mode = input[40];
	chunk->regulatory.flags = input[41];
	chunk->data = input + EDGEZ_PAWR_BULK_HEADER_SIZE;

	return chunk->data_length <= EDGEZ_PAWR_BULK_CHUNK_DATA_SIZE &&
	       EDGEZ_PAWR_BULK_HEADER_SIZE + chunk->data_length == length &&
	       chunk->chunk_count > 0U && chunk->chunk_index < chunk->chunk_count &&
	       chunk->window_count > 0U &&
	       chunk->window_count <= EDGEZ_PAWR_BULK_MAX_WINDOW &&
	       chunk->chunk_index >= chunk->window_base_chunk &&
	       chunk->chunk_index - chunk->window_base_chunk < chunk->window_count &&
	       chunk->offset + chunk->data_length <= chunk->total_length;
}

static inline size_t edgez_pawr_bulk_control_encode(
	uint8_t *output, size_t capacity,
	const struct edgez_pawr_bulk_control *control)
{
	if (!output || !control || capacity < EDGEZ_PAWR_BULK_CONTROL_SIZE ||
	    (control->kind != EDGEZ_PAWR_BULK_KIND_ACK_QUERY &&
	     control->kind != EDGEZ_PAWR_BULK_KIND_BLOCK_ACK) ||
	    control->chunk_count == 0U ||
	    control->chunk_count > EDGEZ_PAWR_BULK_MAX_WINDOW ||
	    (control->bitmap & ~((control->chunk_count == 32U) ? UINT32_MAX :
		((UINT32_C(1) << control->chunk_count) - 1U))) != 0U) {
		return 0U;
	}
	memset(output, 0, EDGEZ_PAWR_BULK_CONTROL_SIZE);
	edgez_pawr_bulk_put_u32(output, EDGEZ_PAWR_BULK_MAGIC);
	output[4] = EDGEZ_PAWR_BULK_VERSION;
	output[6] = control->test_index;
	output[7] = (uint8_t)control->kind;
	edgez_pawr_bulk_put_u32(output + 8, control->session_id);
	edgez_pawr_bulk_put_u16(output + 12, control->window_id);
	edgez_pawr_bulk_put_u16(output + 14, control->base_chunk);
	output[16] = control->chunk_count;
	edgez_pawr_bulk_put_u32(output + 18, control->bitmap);
	return EDGEZ_PAWR_BULK_CONTROL_SIZE;
}

static inline bool edgez_pawr_bulk_control_decode(
	const uint8_t *input, size_t length,
	struct edgez_pawr_bulk_control *control)
{
	if (!input || !control || length != EDGEZ_PAWR_BULK_CONTROL_SIZE ||
	    edgez_pawr_bulk_get_u32(input) != EDGEZ_PAWR_BULK_MAGIC ||
	    input[4] != EDGEZ_PAWR_BULK_VERSION || input[5] != 0U ||
	    (input[7] != EDGEZ_PAWR_BULK_KIND_ACK_QUERY &&
	     input[7] != EDGEZ_PAWR_BULK_KIND_BLOCK_ACK) || input[16] == 0U ||
	    input[16] > EDGEZ_PAWR_BULK_MAX_WINDOW) {
		return false;
	}
	memset(control, 0, sizeof(*control));
	control->kind = (enum edgez_pawr_bulk_kind)input[7];
	control->test_index = input[6];
	control->session_id = edgez_pawr_bulk_get_u32(input + 8);
	control->window_id = edgez_pawr_bulk_get_u16(input + 12);
	control->base_chunk = edgez_pawr_bulk_get_u16(input + 14);
	control->chunk_count = input[16];
	control->bitmap = edgez_pawr_bulk_get_u32(input + 18);
	const uint32_t valid = control->chunk_count == 32U ? UINT32_MAX :
		((UINT32_C(1) << control->chunk_count) - 1U);
	return input[17] == 0U && input[22] == 0U && input[23] == 0U &&
	       (control->bitmap & ~valid) == 0U &&
	       (control->kind == EDGEZ_PAWR_BULK_KIND_BLOCK_ACK ||
		control->bitmap == 0U);
}

static inline bool edgez_pawr_bulk_control_matches(
	const struct edgez_pawr_bulk_control *control, uint32_t session_id,
	uint8_t test_index, uint16_t window_id, uint16_t base_chunk,
	uint8_t chunk_count)
{
	return control && control->session_id == session_id &&
	       control->test_index == test_index &&
	       control->window_id == window_id &&
	       control->base_chunk == base_chunk &&
	       control->chunk_count == chunk_count;
}
