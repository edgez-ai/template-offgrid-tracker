#!/usr/bin/env bash
set -euo pipefail
umask 077

payload="dist/mobile/offgrid-tracker-update.payload"
signature="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/offgrid-tracker-update.signature"
manifest="dist/mobile/offgrid-tracker-update.json"
keystore="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/offgrid-tracker-bundle-upload.jks"
trap 'rm -f "$signature" "$keystore" "$payload"' EXIT

if [[ ! -s "$payload" ]]; then
  echo "React Native bundle update payload is missing" >&2
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
java app/scripts/SignAppBundleManifest.java \
  "$keystore" \
  "$ANDROID_KEY_ALIAS" \
  "$payload" \
  "$signature"
node app/scripts/wrap-app-bundle-manifest.mjs \
  "$payload" \
  "$signature" \
  "$manifest"
