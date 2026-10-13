# Mobile companion

The Expo app is a standalone, local-first companion for Offgrid Tracker. It
opens directly to the Home page and does not require an account, an Appwrite
project, or cloud configuration.

On first launch, the user creates an on-device profile containing its name,
country, map location, HaLow channel, mesh ID, and optional mesh passphrase.
After that the app opens to the full-screen offline map Home page, centered on
the selected profile location, with the add-device button and menu available
over the map. Lower-right controls switch between day/night map themes and
center the map on the phone's current location. Menu → Settings opens the profile summary, and its Manage Profiles
second-level page provides local profile selection, creation, editing, and
deletion. Profiles and the active selection are stored in SQLite;
they do not require a cloud account or backend. A legacy AsyncStorage profile is
migrated automatically. Native device discovery, provisioning, mapping, and
firmware tooling remain available through `@edgez/react-native-sdk` for the next
application flows.

The `+ ADD` flow discovers supported devices locally and provisions the active
profile's HaLow settings without cloud credentials or upstream network
selection. Provisioned devices receive locally generated UUIDs and are stored
per profile in SQLite; devices with saved coordinates appear on the offline map.
The UUID is generated before provisioning and sent to the firmware, then the
same value is committed to SQLite after the firmware confirms persistence.
ESP32 uses secure ESP-IDF BLE provisioning; nRF54 uses its separate chunked
GATT provisioning service.

## Configuration

Copy `.env.example` to `.env` when you need to override the defaults:

- `APP_NAME` controls the display name and Android package suffix.
- `DOMAIN_SUFFIX` controls the Android package prefix.
- `OFFGRID_TRACKER_REPOSITORY_URL` identifies the GitHub repository used by
  release and bundle-update tooling.
- `EDGEZ_OTA_PROXY_URL` and `EDGEZ_BUNDLE_RUNTIME_VERSION` are optional bundle
  update overrides.

No backend credentials belong in the mobile environment.

## Development

```sh
npm install
npm run typecheck
npm run android
```

`npm run android` uses Expo's standard `expo run:android` workflow to generate
the native project when needed, build the development app, install it on the
connected Android device, and start Metro. Set `ANDROID_SERIAL` when more than
one Android device is connected.

BLE provisioning and Organic Maps use native modules and do not run in stock
Expo Go. Rebuild the development client after changing native modules.
