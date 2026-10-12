/* HT-HC33 mesh power-save A/B experiment. */

#pragma once

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Start the test task. The task waits until an 802.11s peer is established. */
esp_err_t mesh_ps_test_start(void);

/** Update the peer-link state from the HaLow service status callback. */
void mesh_ps_test_notify_link(bool connected);

#ifdef __cplusplus
}
#endif
