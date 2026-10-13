# Mobile companion

The Expo app is a standalone, local-first companion for Offgrid Tracker. It
opens directly to the Home page and does not require an account, an Appwrite
project, or cloud configuration.

The current Home page provides an at-a-glance local network overview and an
empty state for devices that will be added through local provisioning. Native
device discovery, provisioning, mapping, and firmware tooling remain available
through `@edgez/react-native-sdk` for the next application flows.

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
