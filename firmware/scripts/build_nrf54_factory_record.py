#!/usr/bin/env python3
"""Build and inspect an EdgeZ sensor immutable factory partition."""

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
VERSION = 2
SERIAL_SIZE = 33
KEY_SIZE = 32
COUNTRY_SIZE = 3
MESH_ID_SIZE = 33
PASSPHRASE_SIZE = 65
RECORD_FORMAT = "<IHH33s32s32s3s33sB65sI"
RECORD_SIZE = struct.calcsize(RECORD_FORMAT)
PARTITION_SIZE = 0x1000
PARTITION_ADDRESSES = {
    "nrf54": "0x165000",
    "ht-hc33": "0x7e3000",
}
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


def fixed_utf8(value: str, field: str, capacity: int) -> bytes:
    encoded = value.encode("utf-8")
    if not encoded or len(encoded) >= capacity or b"\0" in encoded:
        raise ValueError(
            f"{field} must contain 1-{capacity - 1} non-NUL UTF-8 bytes")
    return encoded + bytes(capacity - len(encoded))


def build(serial: str, private_key: pathlib.Path, output: pathlib.Path,
          manifest: pathlib.Path | None, country: str, mesh_id: str,
          channel: int, passphrase: str, target: str) -> None:
    serial_bytes = serial.encode("utf-8")
    if not serial_bytes or len(serial_bytes) > SERIAL_SIZE - 1 or b"\0" in serial_bytes:
        raise ValueError("serial must contain 1-32 non-NUL UTF-8 bytes")
    if len(country) != 2 or not country.isascii() or not country.isalpha():
        raise ValueError("country must be a two-letter ASCII country code")
    if target == "nrf54" and not 1 <= channel <= 255:
        raise ValueError("nRF54 factory data requires a discovery channel from 1 to 255")
    profile_present = bool(mesh_id) or bool(passphrase)
    if profile_present and (not mesh_id or not 1 <= channel <= 255):
        raise ValueError(
            "factory HaLow profile must be complete (mesh-id and channel 1-255) or entirely blank")
    passphrase_bytes = passphrase.encode("utf-8")
    if (not (len(passphrase_bytes) == 0 or
             8 <= len(passphrase_bytes) < PASSPHRASE_SIZE) or
            b"\0" in passphrase_bytes):
        raise ValueError("passphrase must be empty or contain 8-64 non-NUL UTF-8 bytes")
    private_raw, public_raw = raw_keypair(private_key)
    serial_field = serial_bytes + bytes(SERIAL_SIZE - len(serial_bytes))
    country_field = country.upper().encode("ascii") + b"\0"
    mesh_id_field = (fixed_utf8(mesh_id, "mesh-id", MESH_ID_SIZE)
                     if mesh_id else bytes(MESH_ID_SIZE))
    passphrase_field = passphrase_bytes + bytes(PASSPHRASE_SIZE - len(passphrase_bytes))
    body = struct.pack("<IHH33s32s32s3s33sB65s", MAGIC, VERSION, RECORD_SIZE,
                       serial_field, public_raw, private_raw, country_field,
                       mesh_id_field, channel, passphrase_field)
    crc = zlib.crc32(body) & 0xFFFFFFFF
    record = body + struct.pack("<I", crc)
    if len(record) != RECORD_SIZE:
        raise AssertionError(f"unexpected record length {len(record)}")
    output.write_bytes(record + bytes([0xFF]) * (PARTITION_SIZE - len(record)))
    if manifest:
        manifest.write_text(json.dumps({
            "format": "edgez-sensor-factory-v2",
            "target": target,
            "serial": serial,
            "country": country.upper(),
            "meshId": mesh_id,
            "channel": channel,
            "passphraseConfigured": bool(passphrase),
            "hasHalowProfile": profile_present,
            "partitionAddress": PARTITION_ADDRESSES[target],
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
    (magic, version, length, serial_field, public, private, country_field,
     mesh_id_field, channel, passphrase_field, stored_crc) = struct.unpack(
        RECORD_FORMAT, data[:RECORD_SIZE])
    calculated_crc = zlib.crc32(data[:RECORD_SIZE - 4]) & 0xFFFFFFFF
    fields_terminated = (b"\0" in serial_field and
                         country_field[2] == 0 and
                         b"\0" in mesh_id_field and
                         b"\0" in passphrase_field)
    try:
        serial = serial_field.split(b"\0", 1)[0].decode("utf-8")
        country = country_field.split(b"\0", 1)[0].decode("ascii")
        mesh_id = mesh_id_field.split(b"\0", 1)[0].decode("utf-8")
        passphrase = passphrase_field.split(b"\0", 1)[0].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("serial is not valid UTF-8") from error
    valid = (magic == MAGIC and version == VERSION and length == RECORD_SIZE and
             fields_terminated and
             bool(serial) and len(country) == 2 and
             ((not mesh_id and not passphrase) or
              (bool(mesh_id) and channel != 0)) and
             (not passphrase or 8 <= len(passphrase.encode()) <= 64) and
             stored_crc == calculated_crc and
             any(public) and any(private))
    print(json.dumps({
        "valid": valid,
        "serial": serial,
        "country": country,
        "meshId": mesh_id,
        "channel": channel,
        "passphraseConfigured": bool(passphrase),
        "hasHalowProfile": bool(mesh_id),
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
    create.add_argument("--country", required=True)
    create.add_argument("--mesh-id", default="")
    create.add_argument("--channel", type=int, default=0)
    create.add_argument("--passphrase", default="")
    create.add_argument("--target", choices=PARTITION_ADDRESSES,
                        default="nrf54")
    create.add_argument("--output", type=pathlib.Path, required=True)
    create.add_argument("--manifest", type=pathlib.Path)
    show = subparsers.add_parser("inspect")
    show.add_argument("image", type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.command == "create":
            build(args.serial, args.private_key, args.output, args.manifest,
                  args.country, args.mesh_id, args.channel, args.passphrase,
                  args.target)
        else:
            inspect(args.image)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
