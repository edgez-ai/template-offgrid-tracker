# KEEPTEEN app shell

Native implementation of the KEEPTEEN UI handoff
(`WangPaoPaoLab/template-offgrid-tracker@ui/prototype-handoff`,
`docs/KEEPTEEN_UI_HANDOFF.md`, requirements R01–R41) on top of the existing
Offgrid Tracker runtime. `App.tsx` still owns profiles, BLE/mesh, SQLite,
cloud polling and message retries; it now renders `KeepteenApp` instead of the
old map home screen and hands it a `KeepteenRuntime` + `KeepteenActions`
(`types.ts`). The demo adapter from the web prototype was not ported.

## Structure

| Requirement | Implementation |
| --- | --- |
| R01 root nav only Devices / Settings, hidden inside products | `KeepteenApp.tsx` (`TabBar`, 108×48 items, 28 px gap) |
| R02–R04, R39 home with area tabs, four product cards, empty areas | `DevicesHome.tsx`, artwork in `../assets/keepteen/{light,dark}` |
| R06 valve / camera are cards only | `DevicesHome.tsx` shows "not available" |
| R08–R10 collar → gateway → nodes / map / fences → node detail | `CollarProduct.tsx`, `CollarMap.tsx`, `FenceEditor.tsx`, `collar-model.ts`, `fences.ts` |
| R11–R12 chat: text, image, voice; Sent / Delivered | `ChatProduct.tsx` |
| R13, R38 account as a normal sub-page, code + password | `SettingsPages.tsx` → `AccountPage` |
| R27–R28 six settings items, HaLow saved on phone | `SettingsPages.tsx` |
| R29 chat nickname / identity inside the chat product | `ChatProduct.tsx` → `ChatProfile` |
| R32–R33 joint KEEPTEEN × EdgeZ.ai about page | `SettingsPages.tsx` → `AboutPage` |
| Light / dark / system appearance | `theme.tsx` (tokens from `DESIGN_TOKENS.json`) |
| Languages | `i18n.tsx` (English, 简体中文; typed full tables) |

## Data sources (no invented values)

- **Collar nodes**: non-gateway, non-person `StoredDevice` rows of the active
  profile, merged with live `EdgezMeshState.nodes`.
- **Last report**: max of SDK `lastSeenMs`, stored `lastSeenAt` and latest
  sensor sample. "Reporting" = within 30 min; this is a display hint, not a
  calibrated per-model offline rule.
- **Battery**: latest sensor type 12 `batteryVoltage`, shown in V with its
  sample time. No percentage.
- **Signal**: HaLow `topologyLinks` RSSI with reporter and time — never the
  phone's BLE RSSI.
- **Location**: latest GPS sample, then live node, then stored device, with
  its timestamp. Missing stays missing.
- **Rename**: local alias in AsyncStorage (never changes hardware name / key);
  shared rename via `updateCloudDevice` only for cloud profiles when online.
- **Chat**: public channels from `edgezPublicChannelPorts`; direct messages via
  `session.sendTextMessage` with the existing UUID-based ACK/retry
  (`message-delivery.ts`); voice via `session.startVoiceMessage` /
  `finishVoiceMessage` / `playVoiceMessage`.

## Known gaps (kept visible in the UI, not faked)

- **Fences** are stored on the phone (`keepteen.fences.v1:<profileId>`) in the
  cloud `geofence-areas` / `geofence-rules` shape and evaluated in-app as
  "area reminders" only. No cloud sync, gateway execution, background
  monitoring or acknowledgement write-back yet. Empty node scope is rejected so
  it can never mean "whole profile".
- **Images**: the button exists and explains that the firmware link doesn't
  support image transfer yet.
- **Read receipts**: not available; only Sent / Delivered / Not delivered.
  Channels show Sent only.
- **Voice in channels**: disabled (teammates only).
- **Password sign-in / reset**: UI present, disabled — `email-password` is off
  in `appwrite.config.json`.
- **Per-product connections**: Collar and Chat share the profile's single BLE
  companion; product identification from firmware capabilities (R31) is not
  implemented.
- **Notifications**: preferences are stored; system notifications are not
  wired.
- **Languages**: 2 of the prototype's 12. Add a full `Record<MessageKey,
  string>` table to `languages` in `i18n.tsx` for each remaining language.
- Legacy screens still use their original styling: `ProvisioningFlow`,
  `ProfileForm` (network edit), the sensor history / discovery inbox
  (`MeshMessages`) and "Location & beacon" (`SettingsScreens`).
  `HomeMap.tsx` is no longer rendered.
