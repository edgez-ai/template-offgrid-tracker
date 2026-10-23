#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: provision_nrf54_factory.sh --serial SERIAL --jlink-serial JLINK_SN \
	 --country CC --channel N [--mesh-id ID --passphrase PASSPHRASE] \
         --output-dir DIR [--private-key X25519_PEM] [--build-only] [--force]

Creates/imports an X25519 identity, builds the CRC-protected 4 KiB factory
partition image, and writes only the FGH200M factory partition at 0x165000.
Country and channel are always required and exclusively select zero-touch
discovery. Omit mesh/passphrase to require discovery instead of joining a
factory HaLow profile directly.
The private key is saved as identity-private.pem with mode 0600.
EOF
}

serial=""
country=""
mesh_id=""
channel=""
passphrase=""
jlink_serial=""
output_dir=""
source_private_key=""
build_only=0
force=0
while (($#)); do
  case "$1" in
    --serial) serial="${2:?missing serial}"; shift 2 ;;
    --country) country="${2:?missing country}"; shift 2 ;;
    --mesh-id) mesh_id="${2:?missing mesh ID}"; shift 2 ;;
    --channel) channel="${2:?missing channel}"; shift 2 ;;
    --passphrase) passphrase="${2-}"; shift 2 ;;
    --jlink-serial) jlink_serial="${2:?missing J-Link serial}"; shift 2 ;;
    --output-dir) output_dir="${2:?missing output directory}"; shift 2 ;;
    --private-key) source_private_key="${2:?missing private key}"; shift 2 ;;
    --build-only) build_only=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$serial" || -z "$country" || -z "$channel" ||
      -z "$output_dir" || ($build_only -eq 0 && -z "$jlink_serial") ]]; then
  usage >&2
  exit 2
fi
for command in openssl python3; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
if ((build_only == 0)); then
  command -v JLinkExe >/dev/null || { echo "JLinkExe is required" >&2; exit 1; }
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
private_key="$output_dir/identity-private.pem"
public_key="$output_dir/identity-public.pem"
factory_image="$output_dir/factory-partition.bin"
manifest="$output_dir/factory-manifest.json"

if ((force == 0)); then
  for path in "$private_key" "$public_key" "$factory_image" "$manifest"; do
    if [[ -e "$path" ]]; then
      echo "Refusing to overwrite $path (use --force)" >&2
      exit 1
    fi
  done
fi

umask 077
if [[ -n "$source_private_key" ]]; then
  openssl pkey -in "$source_private_key" -out "$private_key"
else
  openssl genpkey -algorithm X25519 -out "$private_key"
fi
chmod 600 "$private_key"
openssl pkey -in "$private_key" -pubout -out "$public_key"
python3 "$script_dir/build_nrf54_factory_record.py" create \
  --serial "$serial" --private-key "$private_key" \
  --country "$country" --mesh-id "$mesh_id" --channel "$channel" \
  --passphrase "$passphrase" --target nrf54 \
  --output "$factory_image" --manifest "$manifest"
python3 "$script_dir/build_nrf54_factory_record.py" inspect "$factory_image"

if ((build_only == 1)); then
  echo "Factory image built without flashing: $factory_image"
  exit 0
fi

commander_script="$(mktemp "${TMPDIR:-/tmp}/edgez-factory.XXXXXX")"
trap 'rm -f "$commander_script"' EXIT
FACTORY_IMAGE="$factory_image" python3 - \
  "$script_dir/jlink/factory_partition.jlink.in" "$commander_script" <<'PY'
import os
import pathlib
import sys

template = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
pathlib.Path(sys.argv[2]).write_text(
    template.replace("@FACTORY_IMAGE@", os.environ["FACTORY_IMAGE"]),
    encoding="utf-8",
)
PY

JLinkExe -device NRF54L15_M33 -if SWD -speed 4000 \
  -SelectEmuBySN "$jlink_serial" -CommanderScript "$commander_script"

echo "Factory identity programmed and verified"
echo "  serial: $serial"
echo "  public manifest: $manifest"
echo "  private key (keep secret): $private_key"
