#!/usr/bin/env bash
set -euo pipefail
umask 077

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_root" || ! -d "$sdk_root/build-tools" ]]; then
  echo "Android SDK build tools are unavailable" >&2
  exit 1
fi

build_tools="$(find "$sdk_root/build-tools" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
zipalign="$build_tools/zipalign"
apksigner="$build_tools/apksigner"
if [[ ! -x "$zipalign" || ! -x "$apksigner" ]]; then
  echo "zipalign or apksigner is unavailable in $build_tools" >&2
  exit 1
fi

apk_dir="app/android/app/build/outputs/apk/release"
shopt -s nullglob
apks=("$apk_dir"/*.apk)
shopt -u nullglob
if [[ "${#apks[@]}" -ne 1 ]]; then
  echo "Expected one unsigned release APK in $apk_dir" >&2
  exit 1
fi

mkdir -p dist/mobile
unsigned="dist/mobile/offgrid-tracker-unsigned.apk"
signed="dist/mobile/offgrid-tracker-signed.apk"
temp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
aligned="$temp_dir/offgrid-tracker-aligned.apk"
keystore="$temp_dir/offgrid-tracker-upload.jks"
trap 'rm -f "$aligned" "$keystore"' EXIT

cp "${apks[0]}" "$unsigned"
if "$apksigner" verify "$unsigned" >/dev/null 2>&1; then
  echo "The unsigned release APK was unexpectedly signed" >&2
  exit 1
fi

python3 -c 'import base64, os, sys; sys.stdout.buffer.write(base64.b64decode(os.environ["ANDROID_KEYSTORE_BASE64"]))' > "$keystore"
actual_fingerprint="$(keytool -list -v \
  -keystore "$keystore" \
  -storepass:env ANDROID_KEYSTORE_PASSWORD \
  -alias "$ANDROID_KEY_ALIAS" | awk -F': ' '/SHA256:/{gsub(":", "", $2); print toupper($2); exit}')"
expected_fingerprint="$(printf '%s' "$ANDROID_SIGNING_CERT_SHA256" | tr -d ':[:space:]' | tr '[:lower:]' '[:upper:]')"
if [[ -z "$actual_fingerprint" || "$actual_fingerprint" != "$expected_fingerprint" ]]; then
  echo "Android signing certificate fingerprint does not match the configured organization certificate" >&2
  exit 1
fi
"$zipalign" -P 16 -f 4 "$unsigned" "$aligned"
"$apksigner" sign \
  --ks "$keystore" \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --key-pass env:ANDROID_KEYSTORE_PASSWORD \
  --out "$signed" \
  "$aligned"
"$apksigner" verify --verbose --print-certs "$signed"
