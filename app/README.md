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

- ESP32 advertisements use `EZ_<12-digit HaLow MAC>`; nRF54L15 advertisements
  use `NRF_<12-digit HaLow MAC>`. Both use the same ESP-IDF Security 1 BLE
  provisioning flow, proof of possession (`abcd1234` by default), and the
  compatibility endpoint `mqtt-config`. nRF54L15 retains its device GPS options.
- BLE discovery also accepts `PROV_` names, including nRF54L15 cameras named
  `PROV_CAM<6-digit identity hash>`. These cameras use a factory-derived PoP
  and standard `prov-config` Wi-Fi provisioning. The app sends the profile's
  SSID/MESH ID and network password through that standard endpoint.

Offline provisioning never calls Appwrite or requests MQTT credentials. It
assigns a local device UUID, sends the profile directly to the device, and saves
the device in local SQLite. Only cloud-enabled profiles create cloud Devices
and request their credentials.

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

### Local gateway for offline profiles

With Connect to cloud off, the existing product screens use the
LwM2M REST API at `http://{current Wi-Fi gateway}:8088/api/clients`
without Appwrite authentication. Android reads the current Wi-Fi default route
and lets requests follow Android routing and VPN policy. There is no saved or hardcoded
gateway destination, and Wi-Fi changes trigger reconnection. The app reads model (`/3/0/1`),
serial (`/3/0/2`) and provisioned name (`/31029/0/7`). Gateway results stay
in memory; they are not copied into Appwrite or the local BLE device database.
Identity reads refresh with gateway discovery.

Cloud-enabled profiles do not mount or poll this local gateway view. Android HTTP exceptions remain limited to the local router addresses
`192.168.4.1`, `192.168.12.1` and `192.168.1.1`, plus localhost. These are
security exceptions, not selected gateway destinations; other local router
addresses require an explicit native network-security exception. No global
cleartext-HTTP permission is enabled.

New nRF54L15 factory identities use 12 uppercase hex digits, `EZ_{serial}` BLE
names, and the serial itself as their LwM2M endpoint. After connecting, the
`ez_wifi_prov` capability selects standard SSID/password provisioning even
though the BLE name shares the ESP32 prefix. Legacy `PROV_CAM` discovery stays
available; no existing identity or device database migration is performed.

Factory models `EZ-DEV54-GPS` and `EZ-DEV54-CAM` map local LwM2M clients to
the Collar and Camera product cards respectively. The app reads model from
`/3/0/1` and serial from `/3/0/2`; unknown models are not assigned to a product.
The model label does not change the device hardware selection.

The original home cards, Collar layouts, artwork and styling are preserved.
For capable firmware, provisioning sends the entered name to the encrypted
`mqtt-config` endpoint using its existing `deviceName` JSON field and requires persistent confirmation before sending Wi-Fi credentials.

Offline discovery matches each LwM2M endpoint (serial) against the active
profile's local device records, ignoring hex letter case. Existing records
retain their ID, name and settings, and section, and the app skips both model and name resource reads.
Unknown GPS/Camera clients fetch their model and name and are automatically
inserted into the local list. Insert-only discovery never overwrites a device
created or renamed concurrently. Failed identity reads are retried on later
discovery; discovery never creates cloud records or changes the UI layout.

Offline Collar “Show on map” sends one Execute to `/31028/0/0?timeout=300`
with text argument `0='295'`. Firmware acknowledges receipt immediately with an
empty CoAP ACK and returns a confirmable response as soon as a fresh fix is
available. The gateway preserves JSON text (`latitude`, `longitude`, UTC Unix
`timestamp`) in `content: {format: 0, value: "..."}`. The app validates the result
and opens the map before saving the coordinates locally. No setup writes,
status polling, or separate coordinate reads are performed.

One five-minute deadline covers discovery and the deferred response; the
295-second device timeout leaves five seconds for transport. The gateway and
device firmware must both support the deferred Execute result. Errors/timeouts
open the map with the last known location and a notice. The existing button
shows the remaining wait and can be tapped again to cancel. Leaving the screen
also cancels the HTTP request; an already accepted device acquisition continues
until fix, its own timeout, WNM sleep or context loss. The first-fix extra minute
of GPS power does not delay the response.

The Devices tab supports pull-to-refresh. Offline profiles re-query the current
Wi-Fi gateway's LwM2M registrations, link endpoints to local serials, discover
unknown device identities, and reload the local list. Discovery also refreshes
every 15 seconds while the app is active, on returning to the foreground, and
when selecting Devices. Overlapping refreshes share their pending operation.
Cloud profiles refresh their normal device source without contacting LwM2M.

Offline Camera provides an on-demand Take picture action for each registered
camera endpoint. It executes `/5001/0/0` (30-second REST timeout), then reads
the cached JPEG from `/5001/0/1` using blockwise transfer (300-second REST
timeout). One five-minute deadline bounds the whole operation. The UI shows
capture/download phases, allows cancellation, validates the base64/JPEG, and
displays the last successful picture while a new one is requested. Leaving
the page cancels the pending HTTP operation. No cloud connection is used.

The device must run camera hardware mode 1 with factory model `EZ-DEV54-CAM`.
Existing profile devices are classified by their saved local type; changing
hardware for a test also requires changing that same local device to camera.
The endpoint remains its serial, and captures never create another device row.

The Camera screen reads `/5001/0/3` on opening and with **Refresh resolution**.
Selecting a supported size writes the same resource and reads it back; the next
capture uses that size. **Save to Photos** saves the displayed JPEG to Android
MediaStore under `Pictures/Offgrid Tracker` (no photo-library read permission).
Android 9 and earlier request storage permission when saving. Rebuild the native
Android app after updating the Wi-Fi gateway module to enable saving.

Tap the picture preview for an immersive landscape viewer with no buttons.
Pinch to zoom (100%–500%), drag to pan, and tap again to close. Android Back also
closes the viewer; closing restores the previous orientation and system bars.
Resolution options use a dropdown.

Every completed capture is saved privately under the app document directory,
partitioned by camera endpoint. The gallery reloads these JPEGs after restarting
the app. Tap a thumbnail to view; long press to reveal Delete photo. Deleting
from this gallery does not delete copies already exported to Photos.
