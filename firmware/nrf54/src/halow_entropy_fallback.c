#if defined(CONFIG_WIFI_MORSEMICRO)
#include <stddef.h>
#include <zephyr/random/random.h>

#define EDGEZ_MBEDTLS_ENTROPY_SOURCE_FAILED (-0x003c)

/* Morse's private mbedTLS archive uses the legacy hardware entropy callback
 * even when Zephyr's PSA entropy driver is enabled.  Keep this weak so a board
 * can provide a stronger platform-specific implementation. */
__attribute__((weak)) int mbedtls_hardware_poll(
	void *data, unsigned char *output, size_t len, size_t *olen)
{
	(void)data;

	if (output == NULL || olen == NULL || len == 0U) {
		return EDGEZ_MBEDTLS_ENTROPY_SOURCE_FAILED;
	}

	if (sys_csrand_get(output, len) != 0) {
		return EDGEZ_MBEDTLS_ENTROPY_SOURCE_FAILED;
	}

	*olen = len;
	return 0;
}
#endif
