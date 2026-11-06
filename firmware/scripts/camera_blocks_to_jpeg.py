#!/usr/bin/env python3
"""Reassemble raw JPEG EZBT v4 MQTT block payloads from one camera/session."""
import argparse
import os
from pathlib import Path
import struct
import tempfile

from camera_ble_capture import jpeg_dimensions


def fnv1a32(data: bytes) -> int:
    digest = 0x811C9DC5
    for value in data:
        digest = ((digest ^ value) * 0x01000193) & 0xFFFFFFFF
    return digest


def assemble(frames: list[bytes]) -> bytes:
    identity = None
    output = covered = None
    for frame in frames:
        if len(frame) < 52 or frame[:5] != b"EZBT\x04" or frame[6:8] != b"\x04\x01" or frame[47] != 0:
            raise ValueError("Expected a JPEG EZBT v4 data chunk")
        session, total, offset, digest = struct.unpack_from(">IIII", frame, 8)
        length = struct.unpack_from(">H", frame, 28)[0]
        if not 4 <= total <= 512 * 1024 or not 0 < length <= 1100 or len(frame) != 52 + length or offset + length > total:
            raise ValueError("Invalid image/chunk length")
        current = (session, total, digest)
        if identity is None:
            identity = current
            output, covered = bytearray(total), bytearray(total)
        elif current != identity:
            raise ValueError("Mixed camera sessions; select payload files from one capture")
        for index, value in enumerate(frame[52:], offset):
            if covered[index] and output[index] != value:
                raise ValueError("Conflicting retransmitted chunk")
            output[index], covered[index] = value, 1
    if identity is None or not all(covered):
        raise ValueError("Missing JPEG chunks")
    result = bytes(output)
    if fnv1a32(result) != identity[2]:
        raise ValueError("JPEG digest mismatch")
    if not result.startswith(b"\xff\xd8") or not result.endswith(b"\xff\xd9"):
        raise ValueError("Invalid JPEG markers")
    jpeg_dimensions(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("chunks", nargs="+", type=Path,
                        help="Raw MQTT payload files from one telemetry/blocks/<MAC> capture")
    args = parser.parse_args()
    result = assemble([path.read_bytes() for path in args.chunks])
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as file:
            temporary = file.name
            file.write(result)
        os.replace(temporary, args.output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    width, height = jpeg_dimensions(result)
    print(f"Saved {args.output}: {width}x{height}, {len(result)} bytes")


if __name__ == "__main__":
    main()
