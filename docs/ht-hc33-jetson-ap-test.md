# HT-HC33 to Jetson local HaLow AP test

PlatformIO environment: `ht-hc33-ap-test` in `firmware/`.

This isolated image uses the official `MorseMicro/esp-halow` component and its
pinned official SDK station/supplicant stack, without EdgeZ mesh/PAwR/BLE.
The local credential fragment is `firmware/sdkconfig.defaults.ht-hc33-ap-test.local`:

```conf
CONFIG_OFFGRID_AP_TEST_SSID="EdgeZ-HaLow"
CONFIG_OFFGRID_AP_TEST_PSK="your-local-test-password"
```

Copy `sdkconfig.defaults.ht-hc33-ap-test.local.example` to create that local
fragment on a fresh checkout. That fragment and the generated SDK configuration
are gitignored. `.env` keeps
the test password only as a memo. Firmware binaries contain the credential;
keep local outputs private. If editing defaults after the first build, remove
only `firmware/sdkconfig.ht-hc33-ap-test` to regenerate this test's SDK config.

```sh
git submodule update --init --recursive firmware/platforms/esp-halow-official
cd firmware
pio run -e ht-hc33-ap-test
pio run -e ht-hc33-ap-test -t upload
pio device monitor --port /dev/cu.SLAB_USBtoUART --baud 115200
```

The environment uses the existing HC33 MM6108 SPI/control pins and FGH100M
BCF. The connected board's original NVS/PHY/factory-app partition layout is
retained in `partitions.ht-hc33-ap-test.csv`. No mass erase or NVS erase is used.

The Jetson AP settings for this test are SSID `EdgeZ-HaLow`, country `US`,
S1G channel `26`, operating class `69`, 915 MHz center and 2 MHz bandwidth.
The AP is managed by `edgez-halow-ap.service`; DHCP uses
`edgez-halow-dhcp.service` and supplies addresses in `10.83.0.0/24` without
an internet gateway. Ethernet remains the Jetson's cloud uplink. Local AP
configuration backups have suffix `.before-us-915` on the Jetson.

Firmware logs its HaLow MAC, association state, `DHCP PASS`, then a UDP echo
round trip every five seconds to `10.83.0.1:4242`. An echo receiver must be
running on the Jetson. It accepts only payloads beginning
`edgez-halow-test seq=` and returns the same bytes. Verify all three stages:
AP station association, DHCP lease, and `LOCAL ECHO PASS` on the sensor.

## Verified on 2026-11-16

Built and flashed over the CP2102 UART. The official SDK reported Morselib
2.12.3, MM6108 firmware 1.17.9, and station MAC `02:00:45:a4:5a:2c`.
The Jetson authorized the station using WPA3-SAE and assigned `10.83.0.195`.
Seven consecutive UDP echo replies were confirmed on the HC33 serial console;
the Jetson continued receiving subsequent packets. This verifies association,
DHCP, and bidirectional local traffic, not throughput or long-term reliability.
The original NVS backup is local at `firmware/.pio/hc33-existing-nvs.bin`.
