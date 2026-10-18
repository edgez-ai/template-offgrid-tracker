# Offgrid Tracker mobile app

The Expo app is a standalone, local-first Android companion for Offgrid
Tracker. It opens on the Home page and does not require an account, Appwrite,
MQTT, or an Internet connection.

Profiles may optionally enable **Connect to cloud**. The map and Settings show
`ONLINE` only when cloud is enabled, the user is authenticated, and Android
reports that the Internet is reachable. A signed-in phone without usable
Internet remains `OFFLINE`.

## Data model

The app uses `expo-sqlite` with WAL and foreign-key support. The active profile
is retained across launches. Each profile owns its own:

- HaLow country, channel, mesh ID, and optional passphrase;
- discovered/provisioned devices, including persistent HaLow MAC addresses and
  user public keys; and
- message history and delivery/retry metadata; and
- timestamped sensor samples used by the local statistics view.

Deleting a profile cascades to its devices, messages, and sensor history. Switching profiles
disconnects the previous BLE/mesh session and displays only the selected
profile's data. Legacy AsyncStorage profile data is migrated automatically.
The phone identity/key material, selected BLE device, location mode, fixed
location, beacon icon, and color are shared settings stored separately from
profiles.

## User interface

If no profile exists, the app opens the profile creation flow. The default
country is `US`, channel is `27`, and mesh ID follows the profile name. The
passphrase may be empty or 8–63 characters and has a visibility toggle.

The Home page provides:

- an offline map with persisted peer markers;
- a list alternative;
- day/night and current-location controls;
- add-device and Settings shortcuts; and
- a BLE status button that opens the detailed status dialog also used by a
  profile card.

Messages are organized into `Channels`, `People`, and `Sensors`. Built-in
channels are visible without message history. A person opens a conversation,
while a sensor opens its statistics/detail page. Device detail is available
from the info action. Channel messages are clear text without a conversation
key; direct user conversations use the identity information persisted for the
profile and peer.

Messages that have not been delivered are retried up to three times when the
peer is online. A failed message remains in SQLite and exposes a manual resend
action. Conversation rows show the peer's last-seen beacon time rather than the
last-message time.

## BLE and mesh behavior

The add-device flow discovers supported hardware and provisions only the active
profile's local HaLow settings; there is no upstream Wi-Fi selection.

- ESP32 advertisements use `EZ_<12-digit HaLow MAC>` and Espressif secure BLE
  provisioning with the compatibility endpoint `mqtt-config`.
- nRF54 advertisements use `NRF_<12-digit HaLow MAC>` and the dedicated EdgeZ
  chunked GATT provisioning protocol.

After provisioning, the active profile reconnects to its selected BLE device
automatically. The realtime SDK flow first reads device status and initializes
HaLow when required. Mesh packets then pass transparently between the phone,
BLE device, and HaLow network.

The app periodically broadcasts the active user's beacon. Location mode is:

- `Off`: no location is included;
- `Fixed`: include coordinates chosen on the map; or
- `Live`: include the latest phone location.

A beacon is still transmitted when a live location fix is unavailable. Beacon
icon and color settings are shared app preferences and are rendered on the
offline map by compatible peers.

## Development

Requirements include Node.js/npm, Java 17, the Android SDK, and a connected
Android phone with Bluetooth and location permissions.

```sh
npm ci
npm run typecheck
npm run android
```

`npm run android` uses the standard `expo run:android` workflow: it generates
the native project when needed, builds and installs the development app, and
starts Metro. Set `ANDROID_SERIAL` when multiple phones are attached.

BLE, SQLite, location, and Organic Maps require native modules, so the app does
not run in stock Expo Go. Rebuild after changing a native dependency.

Useful commands:

```sh
npm start
npm run android:debug
npm run android:debug:build
```

## Optional environment values

Copy `.env.example` to `.env` only when overriding defaults:

- `APP_NAME` controls the display name and Android package suffix.
- `DOMAIN_SUFFIX` controls the Android package prefix.
- `APPWRITE_PUBLIC_ENDPOINT` and `APPWRITE_PROJECT_ID` enable the optional
  EdgeZ Cloud login. Release builds read these from GitHub Actions repository
  variables; local builds may provide the same values in `.env`.
- `OFFGRID_TRACKER_REPOSITORY_URL` identifies the repository used by update
  tooling.
- `EDGEZ_OTA_PROXY_URL` and `EDGEZ_BUNDLE_RUNTIME_VERSION` override bundle
  update behavior.

No backend API key or other privileged credential belongs in the mobile
environment. The project ID and public endpoint are client-safe identifiers.

When an active profile enables **Connect to cloud**, the status is `LOGIN`
until an Appwrite email session exists. A successful login reconciles a
profile-scoped Team and profile row, then reports `ONLINE` only while Internet
reachability remains available. The cached session marker preserves the
correct `OFFLINE` state when an authenticated phone temporarily loses access.
