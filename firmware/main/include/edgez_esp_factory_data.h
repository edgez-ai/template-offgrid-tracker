#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define EDGEZ_FACTORY_SERIAL_MAX 32U
#define EDGEZ_FACTORY_KEY_SIZE 32U
#define EDGEZ_FACTORY_COUNTRY_SIZE 3U
#define EDGEZ_FACTORY_MESH_ID_SIZE 33U
#define EDGEZ_FACTORY_PASSPHRASE_SIZE 65U

typedef struct {
    char serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
    uint8_t public_key[EDGEZ_FACTORY_KEY_SIZE];
    uint8_t private_key[EDGEZ_FACTORY_KEY_SIZE];
    char country[EDGEZ_FACTORY_COUNTRY_SIZE];
    char mesh_id[EDGEZ_FACTORY_MESH_ID_SIZE];
    uint8_t channel;
    char passphrase[EDGEZ_FACTORY_PASSPHRASE_SIZE];
    bool has_halow_profile;
} edgez_esp_factory_identity_t;

/** Load and validate the immutable factory_data partition into RAM. */
esp_err_t edgez_esp_factory_data_init(void);

/** Copy the boot-time identity cache; this never reads flash. */
esp_err_t edgez_esp_factory_data_get(edgez_esp_factory_identity_t *identity);

bool edgez_esp_factory_data_is_ready(void);
