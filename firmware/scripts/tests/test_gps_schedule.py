from pathlib import Path
import subprocess
import tempfile
import unittest


class GpsScheduleTest(unittest.TestCase):
    def test_provisioning_timeouts_cadence_and_clock_wrap(self):
        firmware = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "gps.c")
            source.write_text('''#include <assert.h>
#include <stdint.h>
#include "edgez_gps_schedule.h"
int main(void) {
    struct edgez_gps_schedule state = {0};
    assert(edgez_gps_schedule_begin(&state, 0, false) == 0);
    assert(edgez_gps_schedule_begin(&state, 3600000, false) == 0);
    assert(!state.long_attempted);
    const uint32_t start = 3600000;
    assert(edgez_gps_schedule_begin(&state, start, true) == 180000);
    assert(edgez_gps_schedule_begin(&state, start + 180000, true) == 2000);
    assert(edgez_gps_schedule_begin(&state, start + 1799999, true) == 2000);
    assert(edgez_gps_schedule_begin(&state, start + 1800000, true) == 180000);
    assert(edgez_gps_schedule_begin(&state, start + 1860000, true) == 2000);
    uint32_t last = state.last_long_started_ms;
    assert(edgez_gps_schedule_begin(&state, start + 9999999, false) == 0);
    assert(state.last_long_started_ms == last);
    struct edgez_gps_schedule wrap = {0};
    uint32_t near_wrap = UINT32_MAX - 1000;
    assert(edgez_gps_schedule_begin(&wrap, near_wrap, true) == 180000);
    assert(edgez_gps_schedule_begin(&wrap, near_wrap + 60000U, true) == 2000);
    assert(edgez_gps_schedule_begin(&wrap, near_wrap + 1800000U, true) == 180000);
    uint32_t deadline = near_wrap + 2000U;
    assert(!edgez_gps_window_expired(near_wrap, deadline));
    assert(!edgez_gps_window_expired(deadline - 1, deadline));
    assert(edgez_gps_window_expired(deadline, deadline));
    assert(edgez_gps_window_expired(deadline + 1, deadline));
    return 0;
}''')
            binary = Path(directory, "gps")
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-I" + str(firmware / "shared"), str(source), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
