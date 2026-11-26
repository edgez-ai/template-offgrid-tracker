# Offgrid Tracker

Offgrid Tracker is a local-first Android companion for an offline Wi-Fi HaLow mesh. It provisions ESP32 and nRF54L15 devices over BLE,
exchanges private user messages and clear-text channel messages over
BATMAN-adv-lite, discovers peers from mesh beacons, and stores profiles,
devices, and conversations locally.

[![Use this template](https://img.shields.io/badge/Use%20this-template-238636?style=for-the-badge&logo=github)](https://github.com/new?template_name=template-offgrid-tracker&template_owner=edgez-ai)
[![Deploy on EdgeZ](https://img.shields.io/badge/Deploy%20on-EdgeZ-6c5ce7?style=for-the-badge)](https://appwrite.edgez.ai/console/deploy?repo=https%3A%2F%2Fgithub.com%2Fedgez-ai%2Ftemplate-offgrid-tracker)

Offline operation remains the default and does not require Appwrite, MQTT, an
Internet connection, or an upstream Wi-Fi network. A profile can optionally
enable cloud connectivity. Cloud status is online only while that profile is
enabled, the user has an authenticated session, and the phone has verified
Internet reachability.

When cloud connectivity is enabled but the app has no authenticated session,
the status badge reads `LOGIN` and opens the EdgeZ Cloud sign-in dialog. Mobile
release builds obtain the public endpoint and project ID from the
`APPWRITE_PUBLIC_ENDPOINT` and `APPWRITE_PROJECT_ID` repository variables.
After authentication, the app creates or reuses a Team whose ID matches the
local profile, writes the profile row with team-scoped permissions, and saves
the selected profile in Appwrite account preferences. The badge changes to
`ONLINE` only after this setup succeeds and Internet reachability is verified.

## Current features

- Profile-specific HaLow country, bandwidth/channel, mesh ID, and passphrase,
  with shared phone identity, BLE selection, location mode, icon, and color.
- SQLite-backed profiles, devices, peer MAC addresses/public keys, messages,
  sensor history, retry state, and last-seen time.
- Optional profile-level EdgeZ cloud connectivity with explicit online/offline
  status on the map and in Settings.
- Offline map and list views with day/night and current-location controls.
- `Channels`, `People`, and `Sensors` message tabs. Channels are available
  before the first message; discovered users and sensors share the persisted
  device list.
- BLE provisioning for ESP32 and nRF54L15, followed by an automatic realtime
  BLE session for status, mesh traffic, and profile changes.
- Unified beacon and messaging protocol over BLE, PAwR, 802.11s, and
  BATMAN-adv-lite. Undelivered messages are retried up to three times while a
  peer is online and can be retried manually afterward.
- Profile-aware mesh reinitialization. Switching profiles clears the old peer
  and BATMAN routing state before joining the new mesh.
- Low-power nRF54L15 sensor mode for the EdgeZ FGH200M/MM8108 board.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | Expo/React Native Android app and local SQLite data model |
| `site/` | Optional authenticated Next.js cloud portal |
| `function/` | Appwrite MQTT ingestion and telemetry processing Function |
| `infra/` | Rerunnable Appwrite CLI installer used by Deploy on EdgeZ |
| `docs/` | Product screenshots and hardware images |
| `.github/workflows/` | Android builds and deployment maintenance |

See [app/README.md](app/README.md) for mobile details. Device firmware is
maintained independently in [device-firmware](https://github.com/edgez-ai/device-firmware).

## Optional EdgeZ cloud deployment

The root `edgez.json` selects `appwrite.config.json` as the version-controlled
solution plan. **Deploy on EdgeZ** provisions email/password and JWT auth,
web/Android platforms, the profile and telemetry database, Time Series storage,
the MQTT ingestion Function, the Next.js Site, resource variables, and proxy
domains. The deployment is optional; the mobile app and mesh continue to work
locally when the cloud is disabled or unreachable.

For a local infrastructure check:

```sh
cd infra
npm ci
npm run check
```

Managed deployments inject `APP_NAME`, `DOMAIN_SUFFIX`, `APPWRITE_ENDPOINT`,
`APPWRITE_PROJECT_ID`, `APPWRITE_PROJECT_NAME`, and `APPWRITE_API_KEY`. Run
`npm run deploy` only when you intend to reconcile a remote Appwrite project;
`npm run clean` removes the template Site, Function, tables, Time Series store,
proxy rules, and auth platforms while preserving project users and Devices.

For a local mobile build connected to that deployment, copy `app/.env.example`
to `app/.env` and set its public `APPWRITE_PROJECT_ID`. Never put the Appwrite
API key in the mobile environment.

## Clone and initialize

```sh
git clone https://github.com/edgez-ai/template-offgrid-tracker.git
cd template-offgrid-tracker
```

The app repository does not require firmware submodules. Initialize device
platforms recursively in the independent firmware repository when building a device.

## Android app

Requirements:

- Node.js and npm
- Android SDK, Java 17, and an attached Android device
- Bluetooth and location permissions on the phone

```sh
cd app
npm ci
npm run typecheck
npm run android
```

`npm run android` uses the standard `expo run:android` flow. This app contains
native BLE, SQLite, location, and Organic Maps integrations and therefore does
not run in Expo Go. When multiple phones are connected, select one with
`ANDROID_SERIAL`.

First launch opens KEEPTEEN's Devices screen directly. An internal offline
storage profile is created automatically; configure it under Settings → HaLow
before adding a device. Country defaults to `US`, the channel defaults to `27`,
the initial mesh ID is `KEEPTEEN`, and the passphrase may be empty or
8–63 characters. Location mode can be `Off`, `Fixed`, or
`Live`. Live mode uses the phone's current location in periodic self beacons;
a beacon is still sent when location is temporarily unavailable.

The app scans ESP provisioning advertisements by the `EZ_` prefix. Both
platforms use a 12-digit HaLow MAC suffix so the displayed identity stays stable
before and after provisioning; nRF54 provisioning advertisements use the
`NRF_` prefix.

## Device firmware

ESP32 HT-HC33 and nRF54L15 firmware are maintained in
[device-firmware](https://github.com/edgez-ai/device-firmware). The existing nRF54 project stays at `firmware/` there;
the extracted ESP32 project is at `firmware/esp32/`. The default HT-HC33
`ez-dev01` image uses the same BLE provisioning and temporary unprovisioned
companion behavior as EZ-DEV54. Legacy zero-touch sensor targets remain in
the firmware repository.

Follow that repository's build, factory provisioning, hardware and licensing
instructions. The mobile client retains BLE provisioning and device integrations.
No firmware settings or factory records are migrated by this separation.

## CI builds

`mobile.yml` builds the React Native bundle and can optionally create signed
Android APKs when organization signing secrets are configured. Firmware build
and licensing checks run in the independent firmware repository.

## Licensing

Original application code is covered by the root [Apache-2.0 license](LICENSE).
Device dependencies retain their respective licenses; see the firmware
repository's [licensing notice](https://github.com/edgez-ai/device-firmware/blob/main/FIRMWARE-LICENSING.md).

## Validation

```sh
cd app
npm run typecheck
node --test scripts/provisioning-manager.test.cjs
```

Use a physical Android phone to verify BLE provisioning and companion behavior.
