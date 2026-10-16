# nRF54L15 + FGH200M all-sensors-off benchmark

This image establishes the carrier's minimum powered-off baseline. It is based
on `fgh200test/01_power_safe_standby` and intentionally does not run the normal
Offgrid Tracker application.

At boot it:

1. switches off the FGH200M/MM8108, L76K, carrier/XIAO battery-divider, and
   IMU rails;
2. disconnects their SPI, UART, ADC, I2C, interrupt, wake, busy, and reset pins
   so an unpowered peripheral cannot be back-powered through an I/O pin;
3. disables the LED and enables only the active-low P1.08 user-key wake source;
4. enters nRF54L15 System OFF.

Build it from `firmware/`:

```sh
pio run -e edgez-nrf54l15-fgh200m-all-off
```

Flash with PlatformIO/J-Link:

```sh
pio run -e edgez-nrf54l15-fgh200m-all-off -t upload
```

The output image is
`.pio/build/edgez-nrf54l15-fgh200m-all-off/firmware.hex`. Measure after the
startup transient has ended. Pressing KEY wakes the MCU by reset, after which
the firmware immediately isolates the peripherals and enters System OFF again.

Use this only as a hardware leakage benchmark. BLE, HaLow, GPS, IMU sampling,
beacons, provisioning, and factory-reset handling are intentionally absent.
