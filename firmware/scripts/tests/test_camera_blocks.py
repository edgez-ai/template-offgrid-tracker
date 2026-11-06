from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import camera_blocks_to_jpeg as camera

JPEG = bytes.fromhex("FFD8FFC0000B0801E0028001011100FFD9")


def frame(offset, data, session=7, digest=None):
    header = bytearray(52)
    header[:8] = b"EZBT\x04\x07\x04\x01"
    struct.pack_into(">IIII", header, 8, session, len(JPEG), offset,
                     camera.fnv1a32(JPEG) if digest is None else digest)
    struct.pack_into(">H", header, 28, len(data))
    return bytes(header) + data


class CameraBlocksTest(unittest.TestCase):
    def test_out_of_order_and_retransmission(self):
        self.assertEqual(camera.assemble([
            frame(7, JPEG[7:]), frame(0, JPEG[:10]), frame(0, JPEG[:7])]), JPEG)

    def test_missing_data(self):
        with self.assertRaisesRegex(ValueError, "Missing"):
            camera.assemble([frame(0, JPEG[:7])])

    def test_bad_digest(self):
        with self.assertRaisesRegex(ValueError, "digest"):
            camera.assemble([frame(0, JPEG, digest=1)])

    def test_mixed_sessions(self):
        with self.assertRaisesRegex(ValueError, "Mixed"):
            camera.assemble([frame(0, JPEG[:7]), frame(7, JPEG[7:], session=8)])

    def test_conflicting_retransmission(self):
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            camera.assemble([frame(0, JPEG), frame(0, b"bad")])

    def test_readme_indices_match_firmware(self):
        firmware = SCRIPTS.parent
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "modes.c")
            source.write_text('''#include <stdio.h>
#include "camera_resolutions.h"
int main(void) {
    if (camera_resolution_by_index(0) || camera_resolution_by_index(10) ||
        camera_resolution_by_index(65535) || CAMERA_RESOLUTION_DEFAULT_INDEX != 3) return 1;
    for (unsigned i = 1; i <= CAMERA_RESOLUTION_MAX_INDEX; i++) {
        const struct camera_resolution *m = camera_resolution_by_index(i);
        if (camera_resolution_find(m->width, m->height) != m) return 2;
        printf("%u %u %u\\n", i, m->width, m->height);
    }
    return 0;
}''')
            binary = str(Path(directory, "modes"))
            subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-I" + str(firmware / "nrf54/src"), str(source), "-o", binary], check=True)
            actual = [tuple(map(int, line.split())) for line in subprocess.check_output([binary], text=True).splitlines()]
        documented = [(int(i), int(w), int(h)) for i, w, h in re.findall(
            r"\| `(\d+)` \| (?:\*\*)?(\d+) × (\d+)", (firmware / "README.md").read_text())]
        self.assertEqual(actual, documented)
