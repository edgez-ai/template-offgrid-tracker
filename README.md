# Offgrid Tracker

Offgrid Tracker is a local-first Android companion and embedded firmware for an
offline Wi-Fi HaLow mesh. It provisions ESP32 and nRF54L15 devices over BLE,
exchanges private user messages and clear-text channel messages over
BATMAN-adv-lite, discovers peers from mesh beacons, and stores profiles,
devices, and conversations locally.

The current app does not require Appwrite, MQTT, an Internet connection, or an
upstream Wi-Fi network. Cloud deployment files and the legacy ingestion
function may still be present for compatibility, but they are not part of the
offline app and firmware runtime.

## Current features

- Profile-specific HaLow country, bandwidth/channel, mesh ID, and passphrase,
  with shared phone identity, BLE selection, location mode, icon, and color.
- SQLite-backed profiles, devices, peer MAC addresses/public keys, messages,
  retry state, and last-seen time.
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
| `firmware/` | PlatformIO ESP-IDF and Zephyr firmware |
| `firmware/platforms/esp-halow/` | Pinned ESP32 HaLow platform submodule |
| `firmware/platforms/mm-iot-zephyr/` | Pinned nRF54L15 HaLow platform submodule |
| `docs/` | Product screenshots and hardware images |
| `.github/workflows/` | Android and supported firmware CI builds |
| `function/` | Legacy cloud ingestion code; unused by offline operation |

See [app/README.md](app/README.md) and
[firmware/README.md](firmware/README.md) for component-specific details.

## Clone and initialize

The two HaLow platform directories are Git submodules, and each has its own
nested Morse Micro and EdgeZ dependencies. Always initialize recursively:

```sh
git clone --recurse-submodules <repository-url>
cd template-offgrid-tracker
git submodule update --init --recursive
git submodule status --recursive
```

The repository currently pins the top-level platform submodules to:

| Submodule | Revision |
| --- | --- |
| `firmware/platforms/esp-halow` | `66be0e4930880c5cceb96821ddedf96a4c5d523b` |
| `firmware/platforms/mm-iot-zephyr` | `52f86ed30eccea52d5bb2ff7950831ed8e7bf6c6` |

Do not independently update nested Morse SDK, firmware, RF API, or EdgeZ
prebuilt revisions. Update the owning platform submodule and then commit its new
top-level gitlink so the tested dependency set remains reproducible.

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

On first launch, create a profile. Country defaults to `US`, the channel
defaults to `27`, the mesh ID defaults to the profile name, and the passphrase
may be empty or 8–63 characters. Location mode can be `Off`, `Fixed`, or
`Live`. Live mode uses the phone's current location in periodic self beacons;
a beacon is still sent when location is temporarily unavailable.

The app scans ESP provisioning advertisements by the `EZ_` prefix. Both
platforms use a 12-digit HaLow MAC suffix so the displayed identity stays stable
before and after provisioning; nRF54 provisioning advertisements use the
`NRF_` prefix.

## Firmware

Install PlatformIO, initialize all submodules, and build from `firmware/`:

```sh
cd firmware
pio run -e heltec-hc33
pio run -e edgez-nrf54l15-fgh200m
```

Supported development environments are:

| Environment | Hardware | HaLow radio | Upload |
| --- | --- | --- | --- |
| `waveshare-esp32-p4` | Waveshare ESP32-P4 board | MM8108 over USB | esptool |
| `esp32-s3-pawr` | Generic ESP32-S3 test board | MM6108 over SPI | esptool |
| `heltec-hc33` | Heltec HT-HC33 | MM6108 over SPI | esptool |
| `heltec-hc33-mesh-ps` | HT-HC33 mesh power experiment | MM6108 over SPI | esptool |
| `seeed-xiao-nrf54l15-hc01` | XIAO nRF54L15 + HT-HC01 | MM6108 over SPI | J-Link |
| `seeed-xiao-nrf54l15-sense` | XIAO nRF54L15 Sense + FGH100M | MM6108 over SPI | pyOCD |
| `edgez-nrf54l15-fgh200m` | EdgeZ nRF54L15 + FGH200M | MM8108 over SPI | J-Link |
| `edgez-nrf54l15-fgh200m-power` | FGH200M current-measurement image | MM8108 over SPI | J-Link |

Release-style builds use the `edgez-halow-mesh` public headers and protected
prebuilt libraries already pinned inside the platform submodules. To diagnose
the mesh implementation, point both ESP32 and nRF54 builds at a source checkout:

```sh
export EDGEZ_HALOW_MESH_SOURCE_ROOT=/absolute/path/to/edgez-halow-mesh
pio run -e heltec-hc33
pio run -e edgez-nrf54l15-fgh200m
```

Unset the variable to verify the same application against the pinned prebuilts:

```sh
unset EDGEZ_HALOW_MESH_SOURCE_ROOT
pio run -e heltec-hc33
pio run -e edgez-nrf54l15-fgh200m
```

### FGH200M low-power sensor image

`edgez-nrf54l15-fgh200m-power` is the current power-measurement target. When a
profile provisions the device as a sensor, it:

1. Stops BLE and does not start mesh peering, beacons, or BATMAN routing.
2. Keeps the LSM6DSL gyroscope off and lets its accelerometer FIFO batch samples
   while the MCU uses Zephyr tickless System ON idle.
3. Wakes on a 15-second reporting cycle and drains the FIFO.
4. Wakes the L76K GPS and waits up to 10 seconds for a fix. A timeout sends the
   report without a location.
5. Powers the MM8108 rail, sends the beacon through connectionless HaLow PAwR
   with up to three attempts, then stops the radio and cuts its power rail.
6. Pulls GPS wake low, suspends its UART, and returns to tickless sleep.

The power image disables INFO logs, printk, the console, and RTT to avoid
measurement overhead. Garbage from an RTT viewer is therefore expected and is
not a runtime diagnostic. Use `edgez-nrf54l15-fgh200m` or a source build when
logs are required, and use a current meter to validate the power image.

Build the image with:

```sh
cd firmware
pio run -e edgez-nrf54l15-fgh200m-power
```

For reliable flashing, program the generated HEX directly with J-Link. Replace
the serial number with the connected probe:

```sh
JLinkExe -device NRF54L15_M33 -if SWD -speed 4000 -SelectEmuBySN <JLINK_SN>
```

At the J-Link prompt, reset, load
`.pio/build/edgez-nrf54l15-fgh200m-power/firmware.hex`, reset again, and run
the image. `O.K.` or `Contents already match` confirms flash verification.

### Factory reset

On supported nRF54 carriers, hold the user button for five seconds and release
it to erase the stored profile and return to BLE provisioning. ESP32 profiles
use their board-specific factory-reset button behavior described in the
firmware README.

## CI builds

- `mobile.yml` builds the React Native bundle and can optionally create signed
  Android APKs when the organization signing secrets are configured.
- `firmware.yml` builds only the supported release targets `heltec-hc33` and
  `edgez-nrf54l15-fgh200m`, packages licensing/source manifests, and uploads
  short-lived Actions artifacts.

Firmware binaries include components with separate redistribution terms. Read
[FIRMWARE-LICENSING.md](FIRMWARE-LICENSING.md) before publishing them.

## Validation

```sh
cd app && npm run typecheck
cd ../firmware && pio run -e heltec-hc33
pio run -e edgez-nrf54l15-fgh200m
pio run -e edgez-nrf54l15-fgh200m-power
```

For hardware verification, confirm BLE provisioning/realtime status on Android,
peer discovery and messaging between two devices, PAwR reception for a sensor,
and the expected low-current interval between FGH200M reports.
