#!/usr/bin/env python3
"""Validate firmware release policy and RF/license boundaries."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIRMWARE = ROOT / "firmware"
FORBIDDEN_RELEASE_EXTENSIONS = (".bin", ".hex", ".uf2", ".elf")
GPL_PATTERN = re.compile(
    r"SPDX-License-Identifier:\s*[^\n]*(?:AGPL|GPL|LGPL)|"
    r"GNU\s+(?:AFFERO\s+|LESSER\s+)?GENERAL\s+PUBLIC\s+LICENSE",
    re.IGNORECASE,
)
VENDOR_HEADER_PATTERN = re.compile(
    r"#\s*include\s*[<\"](?:mm(?:drv|pkt|wlan|rc|osal|hal|utils)|morse)[^>\"]*[>\"]"
)
VENDOR_SYMBOL_PATTERN = re.compile(
    r"\b(?:mmosal|mmhal|mmutils|mmwlan|mmdrv|mmpkt|mmrc|morse)_[A-Za-z0-9_]+"
)


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_file(path: Path) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        fail(f"required file is missing or empty: {path.relative_to(ROOT)}")


def read(path: Path) -> str:
    require_file(path)
    return path.read_text(encoding="utf-8", errors="replace")


def validate_release_policy() -> None:
    firmware_workflow = ROOT / ".github/workflows/firmware.yml"
    workflow_text = read(firmware_workflow)
    if re.search(r"(?m)^\s{2}release:\s*$", workflow_text):
        fail("firmware workflow must not run from a GitHub Release event")
    if re.search(r"(?m)^\s*contents:\s*write\s*$", workflow_text):
        fail("firmware workflow must not have release-write permission")
    if re.search(r"\bgh\s+release\b", workflow_text):
        fail("firmware workflow must not create or modify GitHub Releases")

    for workflow in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
        contents = read(workflow)
        if not re.search(r"\bgh\s+release\b", contents):
            continue
        lowered = contents.lower()
        leaked = [ext for ext in FORBIDDEN_RELEASE_EXTENSIONS if ext in lowered]
        if leaked:
            fail(
                f"{workflow.relative_to(ROOT)} combines GitHub Release commands "
                f"with firmware file types: {', '.join(leaked)}"
            )


def validate_license_files() -> None:
    require_file(ROOT / "FIRMWARE-LICENSING.md")
    require_file(ROOT / "LICENSE")

    sdk_roots = (
        FIRMWARE / "third_party/esp-halow/halow/components/mm-iot-sdk",
        FIRMWARE / "modules/mm-iot-zephyr/submodules/mm-iot-sdk",
    )
    for sdk_root in sdk_roots:
        gpl = sdk_root / "LICENSES/GPL-3.0-or-later.txt"
        commercial = sdk_root / "LICENSES/LicenseRef-MorseMicroCommercial.txt"
        binary_distribution = sdk_root / "LICENSES/LicenseRef-MorseMicroBDL.txt"
        morselib_readme = sdk_root / "framework/morselib/README.md"
        require_file(gpl)
        require_file(commercial)
        require_file(binary_distribution)
        if "GPLv3" not in read(morselib_readme):
            fail(f"Morse hosted-library GPL notice is missing: {morselib_readme}")

    prebuilt_roots = (
        FIRMWARE
        / "third_party/esp-halow/halow/components/edgez-halow-mesh-prebuilt",
        FIRMWARE
        / "modules/mm-iot-zephyr/submodules/edgez-halow-mesh-prebuilt",
    )
    legal_files = (
        "EDGEZERON-COMMERCIAL-LICENSE",
        "THIRD-PARTY-NOTICES",
        "Apache-2.0",
        "BSD-3-Clause",
    )
    for prebuilt_root in prebuilt_roots:
        for filename in legal_files:
            require_file(prebuilt_root / "licenses" / filename)


def iter_source_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in {
            ".c",
            ".cc",
            ".cpp",
            ".h",
            ".hpp",
            ".cmake",
        }:
            yield path


def validate_rf_repositories() -> None:
    api_roots = (
        FIRMWARE / "third_party/esp-halow/halow/components/edgez-rf-api",
        FIRMWARE / "modules/mm-iot-zephyr/submodules/edgez-rf-api",
    )
    adapter_roots = (
        FIRMWARE / "third_party/esp-halow/halow/components/edgez-rf-morsemicro",
        FIRMWARE / "modules/mm-iot-zephyr/submodules/edgez-rf-morsemicro",
    )

    for api_root in api_roots:
        backend = read(api_root / "include/edgez_rf_backend.h")
        if "EDGEZ_RF_BACKEND_ABI_VERSION" not in backend:
            fail(f"RF API lacks an ABI version: {api_root}")
        if "struct edgez_rf_backend_ops" not in backend:
            fail(f"RF API lacks edgez_rf_backend_ops: {api_root}")
        for source in iter_source_files(api_root):
            contents = read(source)
            if GPL_PATTERN.search(contents):
                fail(f"GPL-family marker entered edgez-rf-api: {source}")
            if VENDOR_HEADER_PATTERN.search(contents) or VENDOR_SYMBOL_PATTERN.search(contents):
                fail(f"Morse-specific dependency entered edgez-rf-api: {source}")

    required_adapter_symbols = (
        "edgez_rf_platform_init",
        "edgez_rf_driver_ops",
        "edgez_rf_bind_umac",
        "edgez_rf_unbind_umac",
    )
    for adapter_root in adapter_roots:
        combined = "\n".join(read(path) for path in iter_source_files(adapter_root))
        if GPL_PATTERN.search(combined):
            fail(f"GPL-family marker entered edgez-rf-morsemicro: {adapter_root}")
        for symbol in required_adapter_symbols:
            if not re.search(rf"\b{re.escape(symbol)}\s*\(", combined):
                fail(f"Morse adapter does not implement {symbol}: {adapter_root}")


def validate_mesh_consumer_boundary() -> None:
    esp_cmake = read(FIRMWARE / "third_party/esp-halow/halow/CMakeLists.txt")
    for dependency in ("edgez-rf-api/component.cmake", "edgez-rf-morsemicro/component.cmake"):
        if dependency not in esp_cmake:
            fail(f"esp-halow does not require {dependency}")

    zephyr_cmake = read(
        FIRMWARE
        / "modules/mm-iot-zephyr/components/morsemicro/libmorse/edgez_join_only.cmake"
    )
    for dependency in ("edgez-rf-api", "edgez-rf-morsemicro"):
        if dependency not in zephyr_cmake:
            fail(f"mm-iot-zephyr does not require {dependency}")

    prebuilt_roots = (
        FIRMWARE
        / "third_party/esp-halow/halow/components/edgez-halow-mesh-prebuilt",
        FIRMWARE
        / "modules/mm-iot-zephyr/submodules/edgez-halow-mesh-prebuilt",
    )
    for prebuilt_root in prebuilt_roots:
        include_root = prebuilt_root / "include"
        for header in include_root.glob("mm*.h"):
            fail(f"Morse-prefixed header escaped the mesh archive: {header}")

    nm = shutil.which("nm")
    if not nm:
        print("WARNING: nm unavailable; skipped archive symbol boundary check")
        return
    for prebuilt_root in prebuilt_roots:
        for archive in sorted((prebuilt_root / "lib").glob("*.a")):
            result = subprocess.run(
                [nm, "-g", "--defined-only", str(archive)],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                fail(f"unable to inspect archive symbols: {archive}: {result.stderr.strip()}")
            if re.search(r"\bmmhal_mesh_ccm_(?:encrypt|decrypt)\b", result.stdout):
                fail(
                    "Morse compatibility symbol entered edgez-halow-mesh; "
                    f"it belongs in edgez-rf-morsemicro: {archive}"
                )


def main() -> None:
    validate_release_policy()
    validate_license_files()
    validate_rf_repositories()
    validate_mesh_consumer_boundary()
    print("Firmware licensing, release, and RF architecture checks passed")


if __name__ == "__main__":
    main()
