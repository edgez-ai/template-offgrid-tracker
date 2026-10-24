# Offgrid Tracker project guide

Read this file before changing this repository.

## Product

Offgrid Tracker is an authenticated Appwrite example for onboarding off-grid
devices and viewing MQTT telemetry. Web and mobile use Appwrite Auth, read the
latest state from TablesDB, and query history from the project Time Series Store
under Appwrite permissions. The Function writes application sensor telemetry. Appwrite Devices owns system status, topology, and RF history.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `site/` | Read-only Next.js telemetry portal. Never create Devices here. |
| `app/` | Expo + React Native BLE provisioning client. |
| `function/` | Appwrite Function; MQTT-to-TablesDB writer and compatibility APIs. |
| `firmware/` | PlatformIO ESP-IDF and Zephyr firmware for ESP32 and nRF54L15 targets. |
| `edgez.json` | EdgeZ solution and workspace manifest. |
| `appwrite.config.json` | Declarative auth, platform, database, Function, and Site plan. |
| `infra/` | Reproducible Appwrite CLI installer. |
| `.github/workflows/` | Android release/manual builds and deployment-link maintenance. |
| `README.md` | Setup guide and environment contract. |

Keep these boundaries. Never expose `APPWRITE_API_KEY` to clients. Authenticated
web and mobile clients read latest state from TablesDB and history from Time
Series; only the Function writes MQTT telemetry.

Cloud-connected mobile profiles use the same online Devices and TablesDB APIs
as the website; they never synchronize local SQLite data into the cloud.
Offline profiles keep their BLE mesh devices, messages, and samples locally.
Only mobile calls the Device credential endpoints. Web and mobile may list
Devices, read the latest `telemetry` row, and query the project Time Series
Store with the active Appwrite session. Serial is the MQTT username and is
unique within the Appwrite project.
MQTT telemetry inherits only the built-in device's read permissions.

Firmware source lives in `firmware/`. The mobile client retains provisioning,
OTA, and USB flashing integrations for its published device release assets.

## Environment

The workspace supplies `APP_NAME`, `DOMAIN_SUFFIX`, `APPWRITE_ENDPOINT`,
`APPWRITE_PROJECT_ID`, `APPWRITE_PROJECT_NAME`, and `APPWRITE_API_KEY`.
Stable resource IDs come from the committed `appwrite.config.json`.
`APPWRITE_PUBLIC_ENDPOINT` may override the client endpoint. Non-local HTTP
client endpoints must be normalized to HTTPS; the CLI may retain its injected
server-side endpoint.

## Validation

- Web: `cd site && npm run typecheck && npm run build`
- Mobile: `cd app && npm run typecheck`
- Function: `cd function && npm run check`
- Infrastructure: `cd infra && npm run check`
- Firmware: `cd firmware && pio run`

`cd app && npm run android` must start Metro and open the project in the remote
EdgeZ Android DevTools client at `127.0.0.1:5555`. Do not run a local Gradle or
Expo native build unless the user explicitly requests one.

Only run `infra/npm run deploy` when the user explicitly asks to change remote
Appwrite state.
`cd infra && npm run clean` deletes the template's deterministic remote
resources but deliberately preserves project users, Devices, and global auth
method settings. Do not execute it unless the user explicitly requests cleanup.

## Native device state

Device status, firmware version, HaLow identity, and transport gateway come from the Devices API. Topology is projected from Appwrite's `deviceTopologyLinks` collection; RF history is available at `/devices/{deviceId}/halow-metrics`. The Function must not write system status or topology. It receives `{clientId, sensors}` projections of combined system reports on the logical `telemetry/sensors` event topic.

Map settings use native `markerType`, `markerColor`, and `location` ([longitude, latitude]) fields. Application GPS measurements remain in sensor telemetry. Do not restore metadata-based marker settings or the application topology table.
