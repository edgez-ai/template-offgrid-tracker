from pathlib import Path
import struct
import sys
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_nrf54_factory_record as factory


def partition(mesh=b"old-mesh", password=b"old-password"):
    body = struct.pack(factory.RECORD_FORMAT, factory.MAGIC, factory.VERSION,
                       factory.RECORD_SIZE, b"device-123", bytes(range(32)),
                       bytes(range(32, 64)), b"US\0", mesh, 39, password, 0)[:-4]
    record = body + struct.pack("<I", zlib.crc32(body) & 0xFFFFFFFF)
    return record + b"\xff" * (factory.PARTITION_SIZE - len(record))


class FactoryMeshResetTest(unittest.TestCase):
    def test_only_credentials_and_crc_change(self):
        before = partition()
        after = factory.without_mesh_profile(before)
        original = struct.unpack(factory.RECORD_FORMAT, before[:factory.RECORD_SIZE])
        changed = struct.unpack(factory.RECORD_FORMAT, after[:factory.RECORD_SIZE])
        self.assertEqual(changed[:7], original[:7])
        self.assertEqual(changed[8], original[8])
        self.assertEqual(changed[7], bytes(factory.MESH_ID_SIZE))
        self.assertEqual(changed[9], bytes(factory.PASSPHRASE_SIZE))
        self.assertEqual(changed[10], zlib.crc32(after[:factory.RECORD_SIZE - 4]) & 0xFFFFFFFF)
        self.assertEqual(after[factory.RECORD_SIZE:], before[factory.RECORD_SIZE:])

    def test_repeat_is_idempotent(self):
        after = factory.without_mesh_profile(partition())
        self.assertEqual(factory.without_mesh_profile(after), after)

    def test_invalid_or_truncated_record_is_rejected(self):
        corrupted = bytearray(partition())
        corrupted[42] ^= 1
        for data in [bytes(corrupted), b"\xff" * factory.PARTITION_SIZE, partition()[:-1]]:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                factory.without_mesh_profile(data)


if __name__ == "__main__":
    unittest.main()
