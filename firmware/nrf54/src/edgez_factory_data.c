/*
 * Copyright 2026 EdgeZeron AI AB
 * SPDX-License-Identifier: Apache-2.0
 */

#include "edgez_factory_data.h"

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include <psa/crypto.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/crc.h>

LOG_MODULE_REGISTER(edgez_factory, LOG_LEVEL_INF);

#define EDGEZ_FACTORY_MAGIC UINT32_C(0x455a4631)
#define EDGEZ_FACTORY_VERSION 1U

struct __packed edgez_factory_record {
	uint32_t magic;
	uint16_t version;
	uint16_t length;
	char serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
	uint8_t public_key[EDGEZ_FACTORY_KEY_SIZE];
	uint8_t private_key[EDGEZ_FACTORY_KEY_SIZE];
	uint32_t crc32;
};

static struct edgez_factory_identity cached_identity;
static bool identity_ready;

static uint32_t record_crc(const struct edgez_factory_record *record)
{
	return crc32_ieee((const uint8_t *)record,
			  offsetof(struct edgez_factory_record, crc32));
}

static bool record_valid(const struct edgez_factory_record *record)
{
	return record->magic == EDGEZ_FACTORY_MAGIC &&
		record->version == EDGEZ_FACTORY_VERSION &&
		record->length == sizeof(*record) &&
		record->serial[0] != '\0' &&
		memchr(record->serial, '\0', sizeof(record->serial)) != NULL &&
		record->crc32 == record_crc(record);
}

static int create_identity(struct edgez_factory_record *record)
{
	uint8_t device_id[16];
	ssize_t id_len = hwinfo_get_device_id(device_id, sizeof(device_id));
	psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
	psa_key_id_t key_id = 0;
	size_t public_len = 0;
	size_t private_len = 0;
	psa_status_t status;

	if (id_len <= 0) {
		return id_len < 0 ? (int)id_len : -ENODATA;
	}
	memset(record, 0, sizeof(*record));
	record->magic = EDGEZ_FACTORY_MAGIC;
	record->version = EDGEZ_FACTORY_VERSION;
	record->length = sizeof(*record);
	for (ssize_t index = 0; index < id_len && index < 16; ++index) {
		snprintf(record->serial + index * 2U,
			 sizeof(record->serial) - index * 2U, "%02X", device_id[index]);
	}

	status = psa_crypto_init();
	if (status != PSA_SUCCESS) {
		return -EIO;
	}
	psa_set_key_type(&attributes,
		PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY));
	psa_set_key_bits(&attributes, 255);
	psa_set_key_usage_flags(&attributes,
		PSA_KEY_USAGE_EXPORT | PSA_KEY_USAGE_DERIVE);
	psa_set_key_algorithm(&attributes, PSA_ALG_ECDH);
	status = psa_generate_key(&attributes, &key_id);
	psa_reset_key_attributes(&attributes);
	if (status == PSA_SUCCESS) {
		status = psa_export_public_key(key_id, record->public_key,
			sizeof(record->public_key), &public_len);
	}
	if (status == PSA_SUCCESS) {
		status = psa_export_key(key_id, record->private_key,
			sizeof(record->private_key), &private_len);
	}
	if (key_id != 0) {
		(void)psa_destroy_key(key_id);
	}
	if (status != PSA_SUCCESS || public_len != EDGEZ_FACTORY_KEY_SIZE ||
	    private_len != EDGEZ_FACTORY_KEY_SIZE) {
		memset(record->public_key, 0, sizeof(record->public_key));
		memset(record->private_key, 0, sizeof(record->private_key));
		return -EIO;
	}
	record->crc32 = record_crc(record);
	return 0;
}

static int store_record(const struct edgez_factory_record *record)
{
	const struct flash_area *area;
	int rc = flash_area_open(FIXED_PARTITION_ID(factory_partition), &area);

	if (rc != 0) {
		return rc;
	}
	if (area->fa_size < sizeof(*record)) {
		flash_area_close(area);
		return -ENOSPC;
	}
	rc = flash_area_erase(area, 0, area->fa_size);
	if (rc == 0) {
		rc = flash_area_write(area, 0, record, sizeof(*record));
	}
	flash_area_close(area);
	return rc;
}

int edgez_factory_data_init(void)
{
	const struct flash_area *area;
	struct edgez_factory_record record = {0};
	int rc = flash_area_open(FIXED_PARTITION_ID(factory_partition), &area);

	if (rc != 0) {
		return rc;
	}
	rc = flash_area_read(area, 0, &record, sizeof(record));
	flash_area_close(area);
	if (rc != 0) {
		return rc;
	}
	if (!record_valid(&record)) {
		rc = create_identity(&record);
		if (rc != 0) {
			LOG_ERR("factory identity generation failed rc=%d", rc);
			return rc;
		}
		rc = store_record(&record);
		if (rc != 0) {
			LOG_ERR("factory identity write failed rc=%d", rc);
			return rc;
		}
		LOG_INF("factory identity initialized serial=%s", record.serial);
	} else {
		LOG_INF("factory identity loaded serial=%s", record.serial);
	}
	strcpy(cached_identity.serial, record.serial);
	memcpy(cached_identity.public_key, record.public_key,
	       sizeof(cached_identity.public_key));
	memcpy(cached_identity.private_key, record.private_key,
	       sizeof(cached_identity.private_key));
	identity_ready = true;
	memset(&record, 0, sizeof(record));
	return 0;
}

int edgez_factory_data_get(struct edgez_factory_identity *identity)
{
	if (!identity) {
		return -EINVAL;
	}
	if (!identity_ready) {
		return -EAGAIN;
	}
	*identity = cached_identity;
	return 0;
}
