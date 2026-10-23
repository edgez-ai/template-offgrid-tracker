#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: provision_ht_hc33_factory.sh --serial SERIAL --port PORT \
         --country CC [--mesh-id ID --channel N --passphrase PASSPHRASE] \
         --output-dir DIR [--private-key X25519_PEM] [--build-only] [--force]

Creates/imports an X25519 identity, builds the CRC-protected 4 KiB factory
partition image, and writes only the HT-HC33 factory_data partition at 0x7e3000.
Omit mesh/passphrase to create a discovery-only factory identity. Channel may
be supplied as the preferred first discovery channel (zero scans from the
first valid 1 MHz channel).
The private key is saved as identity-private.pem with mode 0600.
EOF
}

serial=""
port=""
country=""
mesh_id=""
channel="0"
passphrase=""
output_dir=""
source_private_key=""
build_only=0
force=0
while (($#)); do
  case "$1" in
    --serial) serial="${2:?missing serial}"; shift 2 ;;
    --port) port="${2:?missing serial port}"; shift 2 ;;
    --country) country="${2:?missing country}"; shift 2 ;;
    --mesh-id) mesh_id="${2:?missing mesh ID}"; shift 2 ;;
    --channel) channel="${2:?missing channel}"; shift 2 ;;
    --passphrase) passphrase="${2-}"; shift 2 ;;
    --output-dir) output_dir="${2:?missing output directory}"; shift 2 ;;
    --private-key) source_private_key="${2:?missing private key}"; shift 2 ;;
    --build-only) build_only=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$serial" || -z "$country" || -z "$output_dir" ||
      ($build_only -eq 0 && -z "$port") ]]; then
  usage >&2
  exit 2
fi
for command in openssl python3; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done
if ((build_only == 0)); then
  command -v esptool.py >/dev/null || { echo "esptool.py is required" >&2; exit 1; }
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
  --passphrase "$passphrase" --target ht-hc33 \
  --output "$factory_image" --manifest "$manifest"
python3 "$script_dir/build_nrf54_factory_record.py" inspect "$factory_image"

if ((build_only == 1)); then
  echo "Factory image built without flashing: $factory_image"
  exit 0
fi

esptool.py --chip esp32s3 --port "$port" write_flash 0x7e3000 "$factory_image"
echo "Factory identity programmed and verified"
echo "  serial: $serial"
echo "  public manifest: $manifest"
echo "  private key (keep secret): $private_key"
