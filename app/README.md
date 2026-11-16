# Offgrid Tracker mobile app

The Expo app is a standalone, local-first Android companion for Offgrid
Tracker. It opens on the Home page and does not require an account, Appwrite,
MQTT, or an Internet connection.

Profiles may optionally enable **Connect to cloud**. The map and Settings show
`ONLINE` only when cloud is enabled, the user is authenticated, and a cloud
data refresh succeeds. Android's physical connection state suppresses requests
only when the link is explicitly disconnected; OS Internet validation is not
used because it can depend on connectivity-check services unavailable in some
regions. A signed-in phone that cannot reach Appwrite remains `OFFLINE`.

Offline profiles save devices, messages, and sensor samples in local SQLite and
use the BLE mesh transport. Cloud-connected profiles do not synchronize that
local database. They read gateways and sensors directly from the Appwrite
Devices API, sensor history directly from TablesDB, and MQTT discovery records
through the Devices API, matching the website's source of truth. Cloud data is
kept in memory and refreshed every five seconds.

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

First launch opens the KEEPTEEN Devices screen directly, with four product
cards and Devices / Settings navigation. The app creates an internal offline
storage profile when none exists; no profile setup or login blocks the home
screen. Existing profiles are retained. Configure the network under
Settings → HaLow before adding a device. The initial local defaults are country
`US`, channel `27`, mesh ID `KEEPTEEN`, and an empty passphrase. No device is
paired automatically. The passphrase may be empty or 8–63 characters.

The Home page provides:

- an offline map with persisted peer markers;
- a list alternative;
- day/night and current-location controls;
- add-device and Settings shortcuts; and
- a BLE status button that opens the detailed status dialog also used by a
  profile card.

Offline messages are organized into `Channels`, `People`, `Sensors`, and
`Discovered`. Built-in
channels are visible without message history. A person opens a conversation,
while a sensor opens its statistics/detail page. Device detail is available
from the info action. Channel messages are clear text without a conversation
key; direct user conversations use the identity information persisted for the
profile and peer.

Cloud-connected profiles show only `Gateways`, `Sensors`, and `Discovered`.
They do not expose the local channel or person messaging views.

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

Zero-touch sensors discovered by an MQTT gateway are read directly from the
Appwrite Devices API when their native Device status is `discovered`. They
appear in the same `Discovered` view as local BLE discoveries but are not
copied into the local provisioning-request table. Accepting one encrypts the
active profile for that sensor, calls the Device discovery API, and lets
Appwrite publish the opaque packet to the gateway's system MQTT topic. Local
discoveries continue to use the BLE transport.

The app periodically broadcasts the active user's beacon. Location mode is:

- `Off`: no location is included;
- `Fixed`: include coordinates chosen on the map; or
- `Live`: include the latest phone location.

A beacon is still transmitted when a live location fix is unavailable. Beacon
icon and color settings are shared app preferences and are rendered on the
offline map by compatible peers.

## Development

Requirements include Node.js/npm, JDK 17, and the Android SDK (Android 36,
Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1 and Platform Tools).
Use a local Android emulator for UI checks or a USB-connected Android phone
with Bluetooth and location permissions for hardware verification.

On Windows, set `JAVA_HOME` and `ANDROID_HOME`, and add their `bin` and
`platform-tools` directories to `PATH`. If the workspace toolchain is installed
in the ignored `.android-tools/` directory, load it from `app/` with:

```powershell
. ./scripts/android-env.ps1
adb devices -l
```

```sh
npm ci
npm run typecheck
npm run android
```

`npm run android` uses the standard `expo run:android` workflow: it generates
the native project when needed, builds and installs the development app, and
starts Metro. Set `ANDROID_SERIAL` when multiple phones are attached.
This is a local native build; it does not use a remote EdgeZ DevTools client.
The generated `app/android/` directory and workspace toolchain are ignored by
Git. Native configuration changes belong in Expo config/plugins so they survive
regeneration. An emulator can check navigation, themes and local storage, but
real BLE provisioning, mesh, voice and device telemetry require hardware.

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
  EdgeZ Cloud login. Release builds read the endpoint from a GitHub Actions
  repository variable and the project ID from a repository secret; local builds
  may provide the same values in `.env`.
- `OFFGRID_TRACKER_REPOSITORY_URL` identifies the repository used by update
  tooling.
- `EDGEZ_OTA_PROXY_URL` and `EDGEZ_BUNDLE_RUNTIME_VERSION` override bundle
  update behavior.

No backend API key or other privileged credential belongs in the mobile
environment. The project ID and public endpoint are client-safe identifiers.

When an active profile enables **Connect to cloud**, the status is `LOGIN`
until an Appwrite email session exists. Sign-in uses an email OTP, and Appwrite
creates an account automatically when the email is new. A successful login
reconciles a profile-scoped Team and profile row, then reports `ONLINE` after
the Appwrite data refresh succeeds. The cached session marker preserves login
state while failed cloud requests keep the visible status `OFFLINE`.
Authenticated users can log out from the active profile card in Settings.
