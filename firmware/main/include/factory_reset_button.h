#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Erase NVS when the previous software reset was requested by the button. */
esp_err_t factory_reset_button_handle_pending(void);

/** Configure the button and start the long-press monitor task. */
esp_err_t factory_reset_button_start(void);

#ifdef __cplusplus
}
#endif
