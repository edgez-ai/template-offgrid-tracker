#ifndef EDGEZ_FACTORY_DATA_H
#define EDGEZ_FACTORY_DATA_H

#include <stddef.h>
#include <stdint.h>

#define EDGEZ_FACTORY_SERIAL_MAX 32U
#define EDGEZ_FACTORY_KEY_SIZE 32U

struct edgez_factory_identity {
	char serial[EDGEZ_FACTORY_SERIAL_MAX + 1U];
	uint8_t public_key[EDGEZ_FACTORY_KEY_SIZE];
	uint8_t private_key[EDGEZ_FACTORY_KEY_SIZE];
};

/* Load the immutable per-device identity. A blank factory page is initialized
 * once from the nRF hardware ID and a generated X25519 keypair. */
int edgez_factory_data_init(void);
int edgez_factory_data_get(struct edgez_factory_identity *identity);

#endif
