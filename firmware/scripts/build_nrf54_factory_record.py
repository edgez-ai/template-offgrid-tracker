#!/usr/bin/env python3
"""Build and inspect the FGH200M immutable factory identity partition."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import zlib

MAGIC = 0x455A4631
VERSION = 1
SERIAL_SIZE = 33
KEY_SIZE = 32
RECORD_SIZE = 109
PARTITION_SIZE = 0x1000
PRIVATE_DER_PREFIX = bytes.fromhex("302e020100300506032b656e04220420")
PUBLIC_DER_PREFIX = bytes.fromhex("302a300506032b656e032100")


def openssl_der(private_key: pathlib.Path, public: bool) -> bytes:
    command = ["openssl", "pkey", "-in", str(private_key), "-outform", "DER"]
    if public:
        command.insert(4, "-pubout")
    try:
        return subprocess.run(command, check=True, capture_output=True).stdout
    except FileNotFoundError as error:
        raise ValueError("openssl is required but was not found") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"could not read X25519 private key: {detail}") from error


def raw_keypair(private_key: pathlib.Path) -> tuple[bytes, bytes]:
    private_der = openssl_der(private_key, False)
    public_der = openssl_der(private_key, True)
    if not private_der.startswith(PRIVATE_DER_PREFIX) or len(private_der) != 48:
        raise ValueError("private key is not an unencrypted X25519 PKCS#8 key")
    if not public_der.startswith(PUBLIC_DER_PREFIX) or len(public_der) != 44:
        raise ValueError("derived public key is not X25519 SubjectPublicKeyInfo")
    return private_der[-KEY_SIZE:], public_der[-KEY_SIZE:]


def build(serial: str, private_key: pathlib.Path, output: pathlib.Path,
          manifest: pathlib.Path | None) -> None:
    serial_bytes = serial.encode("utf-8")
    if not serial_bytes or len(serial_bytes) > SERIAL_SIZE - 1 or b"\0" in serial_bytes:
        raise ValueError("serial must contain 1-32 non-NUL UTF-8 bytes")
    private_raw, public_raw = raw_keypair(private_key)
    serial_field = serial_bytes + bytes(SERIAL_SIZE - len(serial_bytes))
    body = struct.pack("<IHH33s32s32s", MAGIC, VERSION, RECORD_SIZE,
                       serial_field, public_raw, private_raw)
    crc = zlib.crc32(body) & 0xFFFFFFFF
    record = body + struct.pack("<I", crc)
    if len(record) != RECORD_SIZE:
        raise AssertionError(f"unexpected record length {len(record)}")
    output.write_bytes(record + bytes([0xFF]) * (PARTITION_SIZE - len(record)))
    if manifest:
        manifest.write_text(json.dumps({
            "format": "edgez-nrf54-factory-v1",
            "serial": serial,
            "partitionAddress": "0x165000",
            "partitionSize": PARTITION_SIZE,
            "recordSize": RECORD_SIZE,
            "crc32": f"{crc:08x}",
            "publicKey": public_raw.hex(),
            "publicKeySha256": hashlib.sha256(public_raw).hexdigest(),
            "imageSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        }, indent=2) + "\n", encoding="utf-8")


def inspect(image: pathlib.Path) -> None:
    data = image.read_bytes()
    if len(data) < RECORD_SIZE:
        raise ValueError(f"image is only {len(data)} bytes")
    magic, version, length, serial_field, public, private, stored_crc = struct.unpack(
        "<IHH33s32s32sI", data[:RECORD_SIZE])
    calculated_crc = zlib.crc32(data[:RECORD_SIZE - 4]) & 0xFFFFFFFF
    try:
        serial = serial_field.split(b"\0", 1)[0].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("serial is not valid UTF-8") from error
    valid = (magic == MAGIC and version == VERSION and length == RECORD_SIZE and
             bool(serial) and stored_crc == calculated_crc and
             any(public) and any(private))
    print(json.dumps({
        "valid": valid,
        "serial": serial,
        "version": version,
        "recordSize": length,
        "crc32": f"{stored_crc:08x}",
        "publicKey": public.hex(),
        "publicKeySha256": hashlib.sha256(public).hexdigest(),
    }, indent=2))
    if not valid:
        raise ValueError("factory record validation failed")


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--serial", required=True)
    create.add_argument("--private-key", type=pathlib.Path, required=True)
    create.add_argument("--output", type=pathlib.Path, required=True)
    create.add_argument("--manifest", type=pathlib.Path)
    show = subparsers.add_parser("inspect")
    show.add_argument("image", type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            build(args.serial, args.private_key, args.output, args.manifest)
        else:
            inspect(args.image)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
