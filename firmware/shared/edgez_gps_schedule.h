#ifndef EDGEZ_GPS_SCHEDULE_H
#define EDGEZ_GPS_SCHEDULE_H

#include <stdbool.h>
#include <stdint.h>

#define EDGEZ_GPS_SHORT_TIMEOUT_MS 2000U
#define EDGEZ_GPS_LONG_TIMEOUT_MS 180000U
#define EDGEZ_GPS_LONG_INTERVAL_MS 1800000U

struct edgez_gps_schedule {
    uint32_t last_long_started_ms;
    bool long_attempted;
};

/* Unprovisioned discovery never consumes a GPS acquisition window. Long
 * attempts are scheduled from their start, even when they time out. */
static inline uint32_t edgez_gps_schedule_begin(struct edgez_gps_schedule *state,
                                              uint32_t now, bool provisioned)
{
    if (!provisioned) return 0U;
    if (!state->long_attempted ||
        (uint32_t)(now - state->last_long_started_ms) >= EDGEZ_GPS_LONG_INTERVAL_MS) {
        state->long_attempted = true;
        state->last_long_started_ms = now;
        return EDGEZ_GPS_LONG_TIMEOUT_MS;
    }
    return EDGEZ_GPS_SHORT_TIMEOUT_MS;
}

static inline bool edgez_gps_window_expired(uint32_t now, uint32_t deadline)
{
    return (int32_t)(now - deadline) >= 0;
}

#endif
