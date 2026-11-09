# ESP32 Wi-Fi HaLow mesh and PAwR

This branch runs Morse Micro's official ESP-IDF HaLow stack on an MM8108 USB
adapter connected to ESP32-P4. It includes the public `edgez-ai/esp-halow`
fork's `edgez` branch as the `platforms/esp-halow` Git submodule. That component provides
a native MM8108 USB transport based on the protocol used by Morse Micro's
OpenWrt driver. DAB only selects the USB transport and calls the public
`mmhalow_init()` API. The repository pins the component, SDK, and firmware
submodule revisions.

It also provides an ESP32-S3/MM6108 SPI profile compatible with the internal
live-stocking Wi-Fi HaLow PAwR implementation. The PAwR bridge receives `EZPR`
sleepy-device beacon requests through EdgeZ vendor action frames and returns
the same FNV-1a beacon acknowledgement used by
`edge-device-esp32-internal`.

The component currently:

1. Starts the ESP32-P4 USB 2.0 high-speed host on `BIT0`.
2. Detects the Morse Micro USB VID/PID `325b:8100`.
3. Finds and claims the vendor interface containing the MM8108 memory bulk-IN,
   memory bulk-OUT, and interrupt-IN endpoints.
4. Implements the 12-byte little-endian MM8108 USB command protocol.
5. Exposes chunked (up to 16 KiB per transfer) memory/register read and write
   APIs plus the non-destructive USB reset command.
6. Binds the USB operations to the official morselib transport interface.
7. Loads the component's MM8108B2 firmware and `bcf_mf15457.mbin` board
   configuration, then creates the HaLow network interface.
8. Uses `EU` as the default regulatory country and handles unplug/reconnect at
   the USB transport layer.

## 802.11s mesh mode

The application now starts a full 802.11s mesh station after the MM8108
firmware boots. The SDK migration includes SAE/AMPE peering, mesh peer-link
management, protected mesh data handling, mesh management frames, and HWMP
path support ported from `edge-device-esp32-internal` onto MM-IoT SDK 2.13.

The default profile joins mesh ID `halow-mesh` with SAE passphrase
`12345678`. Change these values before deployment:

- `CONFIG_HALOW_MESH_ID`
- `CONFIG_HALOW_MESH_PASSPHRASE` (empty selects an open mesh)
- `CONFIG_HALOW_MESH_FREQUENCY_KHZ` and
  `CONFIG_HALOW_MESH_BANDWIDTH_MHZ` (must identify a channel in the selected
  regulatory domain)

`CONFIG_HALOW_MESH_AUTO_JOIN=n` leaves the initialized HaLow interface idle.

### EdgeZ BATMAN-IV and MQTT relay

`CONFIG_HALOW_EDGEZ_BATMAN=y` builds the ESP-IDF-specific `edgez_mesh` data plane
from the internal ESP32 implementation. It runs above the secured 802.11s
peer links and keeps `mm-iot-sdk` independent of ESP-IDF. DAB controls whether
it starts at runtime with `CONFIG_DAB_START_BATMAN`. The adapter:

- sends BATMAN-IV OGMs to every authorized HaLow peer (up to four);
- learns and expires multi-hop routes, and immediately invalidates routes when
  their authorized next hop disappears;
- forwards EtherType `0x4305` BATMAN unicast and broadcast traffic; and
- carries the existing `EZMQ` fragment protocol so leaf MQTT payloads can be
  forwarded to an H7608 or ESP gateway.

The application initializes the relay after `mmhalow_connect()`. A leaf starts
forwarding once it receives an MQTT gateway advertisement. An ESP gateway must
provide MQTT publish/command callbacks and call
`edgez_mqtt_set_gateway_online(true)` only after its broker connection is
usable; the standalone DAB application currently leaves those callbacks to the
product integration. `CONFIG_HALOW_EDGEZ_BATMAN_INTERVAL_MS` controls the OGM
interval. The `eu` branch uses 10000 ms and must be paired with the H7608 EU
low-airtime profile so route expiry and gateway advertisements remain aligned.

The build and application policy are separate. `CONFIG_HALOW_EDGEZ_BATMAN` and
`CONFIG_HALOW_EDGEZ_MQTT_RELAY` include the optional framework modules;
`CONFIG_DAB_START_BATMAN` and `CONFIG_DAB_START_MQTT_RELAY` decide whether DAB
starts them. The relay is only one MQTT transport: DAB telemetry accepts a
transport-neutral publish/readiness callback, so a direct ESP MQTT client over
upstream Wi-Fi does not require BATMAN. `CONFIG_DAB_PUBLISH_SYSTEM_STATUS`
independently controls the periodic `system/status` producer.

The standalone ESP application can also run the internal firmware's optional
relay/reporting path. It decodes PAwR Beacon protobufs into the existing
`telemetry/sensors` JSON contract, and every 30 seconds publishes its own
protobuf `system/status` through the configured publisher. Its protobuf uses the
same Appwrite device status, HaLow identity, topology, RF-link, gateway-status,
and Wi-Fi-enabled fields as `template-live-stocking`. RF history includes the
authorized-peer RSSI average/minimum, last mesh scan noise floor, link quality,
peer count, and cumulative BATMAN RX/TX/retry/failure counters. ESP32-S3 also publishes
`telemetry/sensors` when the HT-HC33 battery ADC on the GPIO20-controlled GPIO1
divider returns a valid sample; ESP32-P4 and failed ADC reads omit the sensor
message instead of publishing an empty sensor array. Offline provisioning
stores the app-generated device UUID with the HaLow profile; no Appwrite or MQTT
credentials are accepted or persisted.

The fork keeps the official firmware, BCF, driver, MAC, and network layers,
but selects USB instead of SDIO-over-SPI at component build time. USB mode does
not compile the stock SDIO transport or SPI GPIO shim and does not require
dummy SPI/control pin assignments.

## Build and run

### PlatformIO

Initialize the HaLow component submodule, then build the default Waveshare
ESP32-P4 target:

```sh
git submodule update --init --recursive
cd firmware
pio run
```

Other environments in the same project are:

```sh
pio run -e esp32-s3-pawr
pio run -e heltec-hc33
pio run -e heltec-hc33-mesh-ps
pio run -e edgez-nrf54l15-fgh200m-companion
pio run -e edgez-nrf54l15-fgh200m-sensor
pio run -e seeed-xiao-nrf54l15-hc01
pio run -e seeed-xiao-nrf54l15-sense
```

### HT-HC33 mesh power-save experiment

The `heltec-hc33-mesh-ps` environment waits until the HT-HC33 has established
an 802.11s peer link. It then measures 30 seconds with MM6108 power save
disabled, enables power save with a 100 ms dynamic timeout, and reports the
MM6108 `BUSY` duty cycle every 30 seconds:

```sh
cd firmware
export EDGEZ_HALOW_MESH_SOURCE_ROOT=/absolute/path/to/edgez-halow-mesh
pio run -e heltec-hc33-mesh-ps
pio run -e heltec-hc33-mesh-ps -t upload
pio device monitor -b 115200
```

The ESP32-S3 release prebuilt is available, but this diagnostic experiment uses
a source checkout so its internal power-save logs are enabled. At boot, verify
that the log says
`Private EdgeZ UMAC started ... vif=0`. If it reports another VIF, set
`CONFIG_OFFGRID_MESH_PS_VIF_ID` to that value in the test defaults before
building.

The test profile uses mesh `edgez` on the US 915 MHz / 2 MHz channel. Change
the profile to a channel and country code legal at the test location. It
disables BLE, PAwR, BATMAN, MQTT, and the Wi-Fi extender so application traffic
does not obscure the result. If the peer link drops, the test logs the failure,
disables power save, waits for re-peering, and starts a new baseline.

`MM_BUSY` duty is an MM6108 activity proxy, not a power measurement. Put a
current meter in the HT-HC33 supply path and compare the log-marked `BASELINE`
and `POWER SAVE` periods. A lower `BUSY` duty or supply current only establishes
the power effect; it does not by itself prove reliable buffered message delivery
through an 802.11s peer. This test uses the MM6108 chip-level dynamic power-save
controls; the EdgeZ mesh UMAC does not currently advertise or negotiate the
802.11s mesh power-save protocol.

Normal ESP32 and nRF54 builds use the `edgez-halow-mesh` release prebuilt
pinned inside their platform submodule. A debug build can instead compile a
source checkout selected globally rather than encoded in this repository:

```sh
export EDGEZ_HALOW_MESH_SOURCE_ROOT=/absolute/path/to/edgez-halow-mesh
pio run -e seeed-xiao-nrf54l15-hc01
pio run -e seeed-xiao-nrf54l15-sense
```

This source integration enables EdgeZ diagnostics and routes them through the
Zephyr logging backend. Unset `EDGEZ_HALOW_MESH_SOURCE_ROOT` to return to and
verify the pinned release prebuilt. Protected release archives continue to
exclude the diagnostic implementation.

The FGH200M target is the EdgeZ nRF54L15 board with an MM8108 module. The
Seeed board ID supplies the common nRF54L15 Zephyr/toolchain base only; the
EdgeZ carrier wiring comes from its dedicated devicetree overlay. Both ESP-IDF
and Zephyr obtain the Morse stack, firmware, BCF, public mesh API, and
target-specific EdgeZ mesh archives from the pinned `esp-halow` and
`mm-iot-zephyr` `edgez` submodules. Setting
`EDGEZ_HALOW_MESH_SOURCE_ROOT` replaces only the EdgeZ mesh archives with a
source checkout for diagnostics.
Both targets use the nanopb 0.4.9.1 runtime from `shared/nanopb`; the ESP-IDF
build exposes it as a component and the Zephyr build compiles the same sources.

### License boundary

The repository's Apache-2.0 license applies only to its original application
code. Morse Micro `mm-iot-sdk/framework/morselib` is offered under
`GPL-3.0-or-later OR LicenseRef-MorseMicroCommercial`. The GPL path requires
the corresponding GPL obligations to be satisfied when a combined firmware
binary is distributed; otherwise the distributor needs the applicable Morse
Micro commercial license.

The `edgez-halow-mesh` source, public API headers, and target archives are
governed by the bundled EdgeZ Non-Commercial and Commercial Software License,
not Apache-2.0. Commercial or production use requires a separate written
license from EdgeZeron AI AB. See [the firmware licensing notice](../FIRMWARE-LICENSING.md)
before distributing any build.

### FGH200M low-power sensor image

`edgez-nrf54l15-fgh200m-sensor` is the dedicated sensor build for the EdgeZ
nRF54L15 carrier and FGH200M/MM8108. It compiles without Bluetooth, never enters
the companion peering/BATMAN runtime, batches accelerometer-only LSM6DSL samples
in the hardware FIFO, disables GPS, and uses a 15-second reporting cycle. The first
cycle initializes the MM8108 and configures chip sleep. Later cycles drain the
IMU FIFO, wake the retained radio, send one connectionless PAwR-like beacon,
and wait up to 500 ms for a receiver-generated application acknowledgement.
There is no same-cycle retry. The MM8108 then returns to chip sleep without a
firmware reload, and Zephyr returns to tickless System ON idle.

Before using zero-touch provisioning, manufacture the sensor identity separately:

```sh
./scripts/provision_nrf54_factory.sh \
  --serial FGH200M-000001 \
  --jlink-serial <JLINK_SN> \
  --country US --channel 27 \
  --output-dir ../.factory/FGH200M-000001
```

The script generates or imports an X25519 keypair and writes only the dedicated
factory partition at `0x165000`. The firmware loads that record once at boot;
the provisioning serial and public key then come exclusively from its RAM
cache. A sensor with no valid factory keypair keeps HaLow powered down and
sleeps. Preserve the generated private key and never commit `.factory/`.
The discovery regulatory domain and initial channel also come exclusively from
this factory record. Omit mesh ID/passphrase to exercise discovery; supplying a
complete mesh profile skips discovery.
The sensor, sensor-debug, and sensor-bulk-test PlatformIO environments upload
and debug through OpenOCD with a CMSIS-DAP probe. Build and flash the production
sensor image with:

```sh
pio run -e edgez-nrf54l15-fgh200m-sensor -t upload
```

These environments use the packaged nRF54-capable OpenOCD at 1 MHz, verify
the programmed image, and reset/run only after verification succeeds. They
do not automatically recover or mass-erase a locked target.

For an RTT-enabled image, start an OpenOCD server using the exact flashed ELF:

```sh
python scripts/nrf54_openocd.py serve --elf .pio/build/edgez-nrf54l15-fgh200m-sensor-debug/firmware.elf
```

RTT channel 0 is available on `localhost:9090`, with TCL on port 6666 and GDB
on port 3333. `serve` does not reset unless `--reset` is specified. Stop OpenOCD
and disconnect the debug probe before measuring current externally.

Pass `--upload-port <CMSIS_DAP_SERIAL>` when more than one CMSIS-DAP probe is
connected. To program an existing factory record through OpenOCD:

```sh
python scripts/nrf54_openocd.py flash /path/to/factory-partition.bin --address 0x165000
```

Use `--serial <CMSIS_DAP_SERIAL>` with this helper to select a probe. The factory
builder's `--build-only` option also produces an image for this command. The
companion and legacy factory provisioning script retain J-Link support; their
Commander files remain under `scripts/jlink/`.

See the [narrated low-power sensor demonstration](../docs/halow-pawr-low-power-sensor.md)
for the mobile sensor view and measured wake/transmit waveform.

The power image deliberately disables logging, printk, console, and RTT. Use
the `edgez-nrf54l15-fgh200m-companion` image or a sensor source build with
logging enabled for runtime diagnostics; use a current meter rather than RTT
to validate the sensor image.

### Automated factory PAwR/TWT wake tests

The HC33 `ht-hc33-halow-wake-test` and nRF
`edgez-nrf54l15-fgh200m-sensor-debug` images implement the factory
`edgez-wake-test` experiment on US channel 25 (914.5 MHz / 1 MHz). Build and
flash them sequentially with `EDGEZ_HALOW_MESH_SOURCE_ROOT` set to the source
checkout. Preserve the flashed nRF ELF before changing PlatformIO configuration
or building another environment: PlatformIO can remove an earlier environment's
build output. Keep the nRF factory partition and HC33 NVS intact.

The factory TWT bootstrap broadcasts its PAwR request and learns the current
HC33 from the matching ACK. This allows replacing HC33 even when the nRF has
an older gateway MAC saved in settings. Subsequent TWT traffic addresses the
negotiated peer; the production sensor's gateway selection is unchanged.

The current power test uses a nominal 5-second TWT interval with a 50.176-ms wake
window. The native agreement uses mantissa 39063 and exponent 7 (5.000064 s,
the nearest representation rounded up); HC33 schedules
its USER transmission from that same negotiated interval. Earlier captures
below used the previous 2-second interval.

This factory TWT test performs only one bootstrap exchange per boot. It omits
the boot LED self-test, then sends a sensor report every 60 seconds while
waiting for received HC33 requests; each accepted USER request lights the LED
for five seconds. Periodic reports do not light the LED and retain the current
TWT session. It does not retry failed setup on a timer. Reset both boards and rerun setup
after a failure. The retained session still requires the radio to remain powered.

Sensor profiles use 10000 kernel ticks/s so the GRTC 1 MHz counter has an
integer 100 cycles/tick. The previous 32768 ticks/s setting truncated to
30 cycles/tick, shortening a configured minute to 58.9824 seconds.

With both images flashed, run the CMSIS-DAP bench test using Python with
`pyserial` and `pyelftools` installed:

```sh
python scripts/test_pawr_twt_openocd.py \
  --elf /path/to/exact-flashed-nrf.elf --probe CMSIS_DAP_SERIAL \
  --mode stateless --log /tmp/pawr-stateless.log
```

The runner manages OpenOCD, resets both test boards, waits for HC33's negotiated
session, and sends two serial `w` commands through the application wake handler. It
archives the ELF, logs and JSON result beside the chosen log file. It checks
passive nRF counters for the same session, received commands, completed ACK
transmissions, complete LED cycles, and released host wake. Queued HC33 TX alone
cannot pass. The nRF's test counters do not require RTT log delivery or periodic
polling. OpenOCD and serial are closed at the end; the firmware keeps running.

Serial `w` bypasses GPIO interrupt delivery and button debounce. These automated
results therefore do not verify a physical USER press. Verify that separately
after radio/interface changes. The ESP32-S3 HAL preserves application interrupts
on warm radio restarts; its global stale-interrupt cleanup runs only before the
first GPIO ISR-service installation.

Use `--mode ap` for the explicit AP timing control. It switches only the HC33
test radio to its native AP interface and starts the existing 30-second S1G
beacon test. Resetting HC33 restores its default stateless test mode.
`--keep-beacons` sends serial `c` to keep native AP beacons running until `B`,
`m`, or HC33 reset, including after a `--leave-running` handoff. This requires
the updated HC33 test image. No periodic host refresh is needed.
`--snapshot-after-user` optionally collects MAC statistics
after actual USER traffic, while that traffic already holds host wake. Without
that flag, the existing single snapshot runs 15 seconds after setup.
With the updated HC33 test image, `--mesh-after-seed 18` sends its lab serial
`m` control after timing setup. That stops the temporary beacons and recreates
HC33's mesh interface while retaining the application session and host clock
mapping. The test requires a successful interface change with the same RF MAC,
and waits at least five seconds before the first USER command. The nRF still
retains its manually configured firmware STA context; no on-air association or
mesh peering is performed by this experiment. The November 9 sleep-counter
comparison showed that returning HC33 to mesh, or stopping its AP beacons,
largely stopped radio sleep even while `twt_sp_entered` kept advancing.
Use AP mode with `--keep-beacons` for the current sleep test; the mesh handoff
is a protocol comparison and does not preserve validated sleep behavior.

For a longer test with no debugger connection during boot or USER commands:

```sh
python scripts/test_pawr_twt_openocd.py \
  --elf /path/to/exact-flashed-nrf.elf --probe CMSIS_DAP_SERIAL \
  --mode ap --keep-beacons --normal-boot --duration 140 --wake-delays 24,130 \
  --log /tmp/pawr-normal-boot.log
```

This requires the probe's nRESET wire. The runner clears the Arm debug/system
power requests, pulses nRESET, and closes OpenOCD before firmware
boot. It observes ACKs through HC33 alone, then reattaches without reset to read
the retained test counters and verify the pin-reset reason. Alternatively,
`--detach-after 18 --wake-delays 24,130 --duration 140` closes the debugger after
negotiation; that variant does not perform the subsequent pin reset required
by Nordic's [debug-exit guidance](https://docs.nordicsemi.com/r/bundle/ps_nrf54l15/page/debug.html-debuginterfacemode).
Probe wiring remains connected in both tests. Neither test measures current
or proves RF sleep; use an external meter with the probe physically disconnected
for that acceptance criterion.
After a verified run, `--normal-boot --leave-running` can prepare a fresh session
without the final debugger reattachment. That mode reports only HC33 ACK
observations, sets `functional_pass` to null, and does not claim that nRF LED
counters were checked. It avoids returning the device to Debug Interface mode
just to collect counters before a separate current measurement.

`edgez-nrf54l15-fgh200m-twt-unannounced-test` layers only the unannounced request
bit onto the debug profile for an isolated firmware capability comparison.
It is an experiment, not a low-power image. Native TWT service-period counters
must be checked separately from command acceptance and application reception.

`edgez-nrf54l15-fgh200m-twt-quiet-test` explicitly enables the same announced
factory TWT experiment with LOG, RTT, console, printk and the MAC snapshot
disabled. Its normal-boot test uses HC33 ACKs and passive nRF counters instead
of an RTT connection. Check the generated `.config` before flashing: the TWT
symbols must remain enabled when LOG is disabled. The receive helpers no longer
depend on LOG, which previously caused this entire experiment to disappear
silently from a quiet build. The ordinary production sensor profile remains
separate and does not enable this TWT experiment.

For sleep diagnosis, `edgez-nrf54l15-fgh200m-twt-sleep-audit` adds one bounded
MAC/Apps-core statistics capture at 15 seconds. Apps-core counters include
`powersave_sleep`, `powersave_wake_from_timer`, `powersave_wake_from_pin`, and
`powersave_time_slept`; MAC `twt_sp_entered` alone does not establish sleep.
The bench runner saves `.mac.bin` and `.sleep.bin` responses, including the
before-detach versions. Decode them against the exact Morse firmware metadata
with `edgez-halow-mesh/tools/morse_mac_diagnostics.py`. These queries wake the
transport and are excluded from the ordinary quiet image.

November 9 comparison on the replacement HC33 used the same nRF image and
one HC33 command after 70 seconds. The table shows deltas between the Apps-core
snapshots at roughly 15 seconds and just after that command. Metadata was
checked against the exact loaded Morse firmware. Values are firmware-reported
sleep residency, not measured board current.

| HC33 timing configuration | Observation interval | Reported sleep | TWT service periods advanced |
| --- | ---: | ---: | ---: |
| AP seed, switch to MESH at +18 s | 56.3 s | 3.5 s | 29 |
| AP retained, beacons stop at 30 s | 56.3 s | 10.5 s | 29 |
| AP retained, continuous native beacons | 56.3 s | 48.9 s | 29 |

The continuous-native-beacon case delivered its HC33 command on the first
transmission, completed one LED cycle, and retained exactly one bootstrap
attempt. CPU inspection separately found Zephyr idle, constant latency off,
SPI/UART disabled, and zero HAL deep-sleep vetoes. The observed loss of radio
sleep followed removal of AP timing; adding another CPU sleep call alone does
not address that dependency. The quiet handoff uses AP/STA context with
continuous HC33 beacons; fully stateless TWT sleep is still unverified.

An isolated SET_LONG_SLEEP_CONFIG comparison did enter sleep, but reported
zero TWT service periods and received no later HC33 command. That option is
excluded from the TWT image. It cannot substitute for scheduled reception.

### ESP-IDF CLI

Use ESP-IDF 5.5 or newer:

```sh
git submodule update --init --recursive
export IDF_PATH=/Users/jasonhao/.espressif/v5.5.4/esp-idf
source "$IDF_PATH/export.sh"
idf.py set-target esp32p4
idf.py build
idf.py -p /dev/cu.wchusbserial5B901209671 flash monitor
```

For the ESP32-S3 PAwR board profile:

```sh
rm -f sdkconfig
idf.py fullclean
idf.py set-target esp32s3
idf.py build
```

The target-specific defaults select the internal board wiring: MM6108 SPI
pins RESET=8, WAKE=9, BUSY=7, SCK=4, MOSI=3, MISO=5, CS=2, IRQ=6, with
`bcf_mf08551.mbin`. The ESP32-P4 profile remains in
`sdkconfig.defaults.esp32p4`; ESP32-S3 settings are in
`sdkconfig.defaults.esp32s3`.

### Waveshare factory-reset button

The ESP32-P4 profile uses the Waveshare ESP32-P4-WIFI6-DEV-KIT BOOT button as
an active-low factory-reset button. Hold it for five seconds, then release it.
The firmware restarts, erases the default NVS partition, and returns to BLE
provisioning. It waits for release before restarting because GPIO35 is also a
boot strap.

The GPIO, active level, hold duration, poll interval, task stack, and task
priority are configured through the `CONFIG_DAB_FACTORY_RESET_BUTTON_*`
options. The Waveshare board mapping is selected only by
`sdkconfig.defaults.esp32p4`; it is not hard-coded in the reset implementation.
GPIO35 is also the board's Ethernet RMII TXD1 signal, so disable this reset
button feature before using onboard Ethernet.

### BLE provisioning on ESP32-S3 and ESP32-P4

On an unprovisioned device, both board profiles expose the same Espressif BLE
provisioning contract as `edge-device-esp32-internal`:

- BLE service name: `EZ_<12-character uppercase HaLow MAC>`
- Security: `NETWORK_PROV_SECURITY_1`
- Proof of possession: `abcd1234`
- Custom endpoint: `mqtt-config` (legacy wire name retained for SDK compatibility)

The endpoint accepts the existing device payload. Its required HaLow fields
are:

```json
{
  "clientId": "33c84b34-4599-4ed9-894f-b5f48df6fd8c",
  "meshId": "halow-mesh",
  "passphrase": "12345678",
  "country": "EU",
  "halowChannel": 7
}
```

The country/channel pair is checked against the Morse regulatory database.
The UUID is generated and retained by the mobile app per profile/device. The
firmware stores it with the mesh values and accepts either an empty passphrase
for an open mesh or 8–63 characters for SAE. After the endpoint responds
successfully, BLE shuts down and the device reboots into the saved HaLow mesh.
No upstream Wi-Fi scan or credential provisioning is performed.
Erasing NVS returns it to provisioning mode.

### Direct provisioning on nRF54L15

nRF54 does not run ESP-IDF provisioning. It uses the dedicated EdgeZ GATT
service `a3631000-b82e-44c2-9b1d-a790675b4ac1`, with configuration and status
characteristics ending in `1001` and `1002`. The mobile SDK writes the same
offline JSON in chunks and waits for a matching `confirmationId` response. The
firmware validates and persists the device UUID, country, channel, mesh ID,
passphrase, name, and optional location before allowing HaLow to start. MQTT,
Appwrite, and upstream Wi-Fi fields are neither required nor stored.

ESP32-S3 runs the NimBLE host against its integrated BLE controller. ESP32-P4
has no Bluetooth radio, so the P4 profile connects the same NimBLE provisioning
host to the onboard ESP32-C6 over ESP-Hosted VHCI. The Waveshare
ESP32-P4-WIFI6-DEV-KIT schematic uses SDIO slot 1 (CLK=GPIO18, CMD=GPIO19,
D0..D3=GPIO14..17) and C6 reset/CHIP_PU=GPIO54; these are the ESP-Hosted P4
defaults selected by `sdkconfig.defaults.esp32p4`.

The factory C6 firmware must remain compatible with the host components and
have Bluetooth support enabled. For ESP-IDF 5.5 this project pins the P4 host
to ESP-Hosted 1.4.x and ESP Wi-Fi Remote 0.14.x, matching Waveshare's factory
firmware compatibility line. The factory firmware enables its Bluetooth
controller at startup; do not call the ESP-Hosted 2.5.2+ controller
initialization APIs against it. A `Req_FeatureControl` timeout accompanied by a
reported C6 version of `0.0.0` indicates that a 2.x host was built against the
legacy slave image. If the C6 is upgraded to ESP-Hosted 2.x, upgrade both sides
together and restore the explicit controller init/enable calls. Once a valid
HaLow profile exists, the P4 uses MM8108 USB for HaLow. With
`CONFIG_DAB_WIFI_EXTENDER=y`, ESP-Hosted also runs the C6 Wi-Fi interface during
normal operation. With the option disabled, provisioned boots leave it inactive.

### Wi-Fi extender

`CONFIG_DAB_WIFI_EXTENDER` defaults to off in Kconfig and is enabled in the
project's `sdkconfig.defaults`. It requires BATMAN and enables lwIP forwarding
and NAPT. The forwarding, DNS, gateway selection, Alfred and neighbor discovery
modules are adapted from `edge-device-esp32-internal`'s `wifi-extender` branch
at `3016950`, with OpenWrt `EZGW1` compatibility and proactive neighbor
advertisement adapted from the `v2` source.

- Offline mode starts a WPA2 `EZ-<Wi-Fi MAC>` SoftAP. Its password is
  `CONFIG_DAB_WIFI_EXTENDER_PASSWORD` (initially `edgez123`). A deterministic
  MAC-derived `10.80.0.0/12` subnet allocates a /27 per device, with the first
  host as router and 15 DHCP leases (up to 10 associated Wi-Fi clients).
  Traffic uses a DHCP-addressed BATMAN interface, MTU 1400, and a selected
  EdgeZ Mesh Network gateway. A local bounded DNS relay serves downstream clients.
  The offline app never scans for or stores an upstream Wi-Fi network.

As in the reference branch, downstream SoftAP traffic preserves client source
addresses. An EdgeZ Mesh Network/OpenWrt gateway must consume the Alfred type-104
`EZ4R1` subnet advertisements, install return routes, and perform WAN NAT.
Gateway discovery accepts `edgez-subnet-routes` type-105/version-0 `EZGW1`
records (and legacy type-100 protobuf). Modern records require two advancing
sequences in one session and expire after 45 seconds; cached duplicates do not
refresh them. The gateway's bridge MAC is resolved through BATMAN's translation
table to its radio originator. After mesh DHCP succeeds, the ESP publishes its
/27 and DHCP next hop to each Alfred primary, with lifetime zero on withdrawal.
A plain BATMAN gateway without that integration is insufficient for these
routed SoftAP clients; the ESP Wi-Fi gateway role does not install those routes.
ESP provisioning continues to use the legacy BLE `mqtt-config` endpoint name
for SDK compatibility, but its payload is entirely local/offline.
The reference firmware's web configuration UI is not included.

The mesh component has a separate network receive callback so IP/ARP/Alfred
delivery coexists with the MQTT relay. It also assigns HaLow its own
`HALOW_STA_DEF` interface key so native Wi-Fi STA can coexist.
Its runtime OGMs include multicast TVLV v2 (including on non-gateway nodes),
requesting IPv4, IPv6 and unsnoopable multicast without claiming support for
BATMAN multicast-tracker packets. This lets Linux forward Alfred's `ff02::1`
announcements with multicast optimization enabled. If discovery stalls, check
`batctl meshif bat0 mcast_flags`: the ESP must be listed, then its Alfred
`RX_DIAG announce` counter should advance before mesh DHCP and subnet publication.

Host checks:

```sh
cc -std=c11 -Wall -Wextra -Werror -I main/include main/test/test_edgez_mesh_gateway_policy.c main/edgez_mesh_gateway_policy.c -o /tmp/dab-test-gateway
/tmp/dab-test-gateway
cc -std=c11 -Wall -Wextra -Werror -I main/include main/test/test_edgez_mesh_ndp.c main/edgez_mesh_ndp.c -o /tmp/dab-test-ndp
/tmp/dab-test-ndp
python3 main/test/dns.py
python3 main/test/mesh_iperf/run.py
python3 main/test/mesh_qos.py
python3 main/test/rx_reorder/run.py
python3 main/test/block_ack/run.py
```

`CONFIG_DAB_MESH_IPERF` defaults off in Kconfig and is enabled in this project's
sdkconfig/defaults for diagnostics. The reference `v2` receive-only iperf2
endpoint starts on the DHCP mesh address once forwarding is ready; gateway
mode also accepts traffic on its Wi-Fi STA address. It closes clients/listeners
when the address or gateway generation changes, and permits one client at a time.
From OpenWrt (or another routed mesh host), use the address printed in
`IPERF RX ready on HaLow`:

```sh
iperf -c <ESP-mesh-IP> -p 5001 -C -t 10 -i 1
```

Use **iperf2**, not iperf3. This endpoint does not support UDP, reverse/dual tests,
parallel streams or enhanced server reports. It tests mesh TCP reachability and
receive throughput, not downstream Wi-Fi forwarding or Internet/DNS by itself.
Disable the unauthenticated diagnostic endpoint after testing.
Verbose RF/MAC/mesh traces and per-packet heap integrity checks are disabled in
the project defaults so UART logging and forensic checks do not distort tests.
The Internet TX worker follows `v2` radio admission: ACK/control frames use
TID 6 with a 20 ms wait, while bulk frames use TID 0 without waiting. Legacy
mesh callers retain TID 0/50 ms. Per-packet Ethernet logs are debug-level.
Unicast retains the driver's native 802.11 ACK/retry and negotiated Block ACK
path; no application-layer ACK protocol is added.
The `v2` Block ACK receive fixes are included: protected unicast management
responses use peer-validated software CCMP with authenticated replay checks,
and each QoS TID has an independent reorder queue. One timer services the
peer's queues and is cancelled on teardown. Block ACK crypto host tests use
OpenSSL 3 at `/usr/local/opt/openssl@3` (adjust the runner on other hosts).

Hardware verification: provision a mesh profile, connect to the SoftAP, verify
the /27 DHCP lease, then check DNS and Internet access through an EdgeZ Mesh Network
gateway with the subnet-route integration. Remove and restore the upstream
gateway to exercise reselection. Test MQTT
telemetry concurrently to verify both mesh consumers remain active.

Both board profiles use the same 8 MB dual-OTA partition layout as
`edge-device-esp32-internal`: two 3 MB application slots plus `ota_data`,
`nvs_key`, `driver_nvs`, `factory_data`, `device_data`, and `spiffs`
partitions. The provisioning profile remains in the regular `nvs` partition.

On the Waveshare ESP32-P4 board revision 1.2, put the USB selector jumper on
`HOST` and connect the MM8108 USB adapter to USB-A port 1. A successful boot
logs the endpoint map, chip ID `0x00000809`, Morse component/firmware/BCF
versions, and then `Morse Micro HaLow network interface ready`.

Change `CONFIG_HALOW_COUNTRY_CODE` before transmitting outside the EU. The
country must match the applicable local regulatory domain.

## Reference implementation

For cross-device mesh diagnosis, including enabling raw `wpa_supplicant_s1g`
logging on an UART-connected H7608, see
[H7608 mesh debugging](docs/h7608-mesh-debug.md).

- Morse Micro OpenWrt `3.1-dev`/3.1.x (MM8108 2.0 driver line)
- Morse Micro `morse_driver/usb.c`
- Morse Micro `morse_driver/mm8108.c`
- Morse Micro `morse-firmware` (matching firmware and board configuration)
- `edgez-ai/esp-halow` branch `edgez`, based on the Morse Micro ESP-IDF component
  `2.11.2-esp32-2`
