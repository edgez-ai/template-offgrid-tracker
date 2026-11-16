# Jetson HaLow AP integration test

`edgez-nrf54l15-fgh200m-ap-test` is a standalone station image for the existing
EdgeZ nRF54L15 + FGH200M/MM8108 carrier, using its normal SPI/power wiring.
It uses the reference Morse Wi-Fi station stack through Zephyr's networking API,
not the production connectionless/mesh protocol. It does not change factory data.
Do not flash it on a bare Nordic DK or a different carrier without adapting wiring.

It joins `EdgeZ-HaLow` using WPA3-SAE in the EU region, obtains a DHCP address,
and repeatedly checks UDP echo at `10.83.0.1:4242`. RTT logs distinguish radio
initialization, association, DHCP, and successful round trips. Connection failures
retry after ten seconds. There is no cloud, MQTT, BLE, or internet dependency.

Run the existing **Build firmware** GitHub workflow on the development branch,
selecting this exact environment. Set `ap_test_compile_only=true` to validate
the build with a dummy password without sharing any AP credential; that
artifact is explicitly labeled `compile-only` and cannot join the Jetson AP.
Leave that option disabled for the real connection test. Configure the repository Actions secret
`EDGEZ_HALOW_TEST_PSK` with the Jetson AP passphrase first. Never commit it.
This diagnostic image contains the test AP passphrase: restrict access to its
Actions artifacts and replace the test password after use. The environment is
excluded from `all` and is not published as a release.

On the Jetson, use a UDP echo receiver bound only to the HaLow address:

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

Verify `AP-STA-CONNECTED` in `journalctl -u edgez-halow-ap`, a lease in
`/var/lib/edgez-halow/dnsmasq.leases`, and `LOCAL ECHO PASS` in sensor RTT output.
A successful compile alone does not verify sensor association or data transfer.
Use the existing CMSIS-DAP/OpenOCD flashing tools and preserve the factory
partition; do not mass-erase or unlock a protected target automatically.
