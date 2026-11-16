# Local Jetson HaLow AP test

Environment: `edgez-nrf54l15-fgh200m-ap-test`.
Board: EdgeZ nRF54L15 + FGH200M/MM8108 carrier with the existing SPI/power wiring.
It uses the unmodified official `MorseMicro/mm-iot-zephyr` integration and its
pinned `MorseMicro/mm-iot-sdk` 2.13.1 station/supplicant implementation.
`edgez-halow-mesh`, EdgeZ RF adapters, and the production SDK fork are not
linked by this environment. The EdgeZ carrier overlay supplies only the wiring.

It joins `EdgeZ-HaLow` with WPA3-SAE in the EU region, obtains a DHCP address,
and checks UDP echo at `10.83.0.1:4242`. RTT logs show association, DHCP, and
`LOCAL ECHO PASS`. No BLE, mesh, PAwR, MQTT, internet, or cloud credentials.

Set the literal credentials in `firmware/zephyr/fgh200m_ap_test.local.conf`:

```conf
CONFIG_WIFI_SSID="EdgeZ-HaLow"
CONFIG_WIFI_PSK="your-test-ap-password"
```

This is the credential fragment equivalent to a local `prj.conf`: PlatformIO
uses `fgh200m_ap_test.conf` as its standalone base and adds the local fragment
with `EXTRA_CONF_FILE`. Copy `.local.conf.example` when setting up another
checkout. The local fragment is gitignored. Root `.env` stores the same password
only as a memo; the firmware build does not load it. Firmware contains the
password, so keep local build outputs private. No GitHub Actions build is used.

```sh
git submodule update --init --recursive firmware/platforms/mm-iot-zephyr-official
cd firmware
pio run -e edgez-nrf54l15-fgh200m-ap-test
pio run -e edgez-nrf54l15-fgh200m-ap-test -t upload
python scripts/nrf54_openocd.py serve --elf .pio/build/edgez-nrf54l15-fgh200m-ap-test/firmware.elf
```

Use a CMSIS-DAP probe attached by SWD to the nRF54L15. The existing uploader
verifies writes and does not automatically recover or mass erase a device.
Factory identity/configuration partitions are preserved.

On the Jetson, a local UDP echo receiver can confirm data transfer:

```python
import socket
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
    server.bind(('10.83.0.1', 4242))
    while True:
        data, peer = server.recvfrom(256)
        if data.startswith(b'edgez-halow-test seq='):
            print(peer, data.decode('ascii', errors='replace'), flush=True)
            server.sendto(data, peer)
```

Check `AP-STA-CONNECTED` in `journalctl -u edgez-halow-ap`, a DHCP lease in
`/var/lib/edgez-halow/dnsmasq.leases`, and sensor RTT `LOCAL ECHO PASS` output.

Pinned upstream integration: `70007b9b9161c62c829d76baf3d022af6c8db2d2`.
Pinned official SDK: `d63724744b9596decf077a791c760319ebcbee05` (2.13.1).
