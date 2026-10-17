# Wi-Fi HaLow PAwR-like low-power sensor demo

[![Play the narrated Wi-Fi HaLow low-power sensor demo](videos/halow-sensor-pawr-low-power-poster.jpg)](videos/halow-sensor-pawr-low-power-voiceover.mp4)

Select the image to play or download the 48-second narrated demonstration.

This prototype uses an nRF54L15 host with the EdgeZ FGH200M/MM8108 radio as a
connectionless, duty-cycled sensor. The term **PAwR-like** describes the
request/response behavior: it is inspired by periodic advertising with
responses, but it is implemented over Wi-Fi HaLow vendor action frames rather
than the Bluetooth PAwR protocol.

The `edgez-nrf54l15-fgh200m-sensor` environment compiles Bluetooth out of the
image and is separate from the `edgez-nrf54l15-fgh200m-companion` BLE/full-mesh
role. With a stored sensor profile, the sensor firmware:

1. Stops BLE and does not run mesh peering, mesh beacons, BATMAN routing, or
   GPS.
2. Uses the LSM6DSL accelerometer hardware FIFO while the nRF54L15 remains in
   tickless System ON idle between reports.
3. Wakes on a 15-second interval, drains the IMU FIFO, and wakes the initialized
   MM8108 from chip sleep.
4. Broadcasts one sensor beacon and waits up to 500 ms for a receiver-generated
   application acknowledgement. It does not retry in the same cycle.
5. Returns the MM8108 to chip sleep and lets the nRF54L15 return to tickless
   idle. The HaLow rail remains powered so later reports avoid firmware reload
   and full radio initialization.

The video shows the mobile sensor view and the supply-current waveform during a
reporting cycle. Treat it as a qualitative demonstration, not a calibrated
battery-life result. Disconnect the J-Link probe and other debug interfaces for
power measurements, and record the supply voltage, reporting interval, RF
conditions, payload size, and acknowledgement behavior with any published
current figure.

Higher HaLow throughput can reduce radio-on time for a given payload, making
this approach attractive when a long-range sensor occasionally needs to send
more data than a conventional low-rate LPWAN node. Actual energy per kilobyte
still depends on wake overhead, RF conditions, data rate, payload size, and the
receiver topology.
