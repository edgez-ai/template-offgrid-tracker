#ifndef EDGEZ_FACTORY_DATA_H
#define EDGEZ_FACTORY_DATA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define EDGEZ_FACTORY_SERIAL_MAX 32U
#define EDGEZ_FACTORY_KEY_SIZE 32U
#define EDGEZ_FACTORY_COUNTRY_SIZE 3U
#define EDGEZ_FACTORY_MESH_ID_SIZE 33U
#define EDGEZ_FACTORY_PASSPHRASE_SIZE 65U

struct edgez_factory_identity {
	char serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
	uint8_t public_key[EDGEZ_FACTORY_KEY_SIZE];
	uint8_t private_key[EDGEZ_FACTORY_KEY_SIZE];
	char country[EDGEZ_FACTORY_COUNTRY_SIZE];
	char mesh_id[EDGEZ_FACTORY_MESH_ID_SIZE];
	uint8_t channel;
	char passphrase[EDGEZ_FACTORY_PASSPHRASE_SIZE];
	bool has_halow_profile;
};

/* Load the immutable per-device identity from the factory partition once at
 * boot. Blank or invalid factory data is never generated at runtime. */
int edgez_factory_data_init(void);

/* These accessors use the boot-time RAM cache and never read flash. */
bool edgez_factory_data_is_ready(void);
int edgez_factory_data_get(struct edgez_factory_identity *identity);

#endif
