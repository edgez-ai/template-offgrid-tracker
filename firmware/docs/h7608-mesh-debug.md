# H7608 HaLow mesh debugging over UART

Use this procedure when an ESP32 HaLow node does not discover or peer with an
EdgeZ Mesh Network H7608. It follows the mesh/BATMAN diagnostic order used by
`edge-device-esp32-internal`, adapted for this repository.

The examples assume:

- the H7608 console is `/dev/cu.usbserial-BG0107WG` at 115200 baud;
- the ESP32 console is a different adapter;
- the H7608 HaLow interface is `wlh0`; and
- the BATMAN interface is `bat0`.

Confirm these names on each setup rather than copying them blindly.

## 1. Connect to the H7608 console

List the serial adapters on macOS:

```sh
python3 -m serial.tools.list_ports -v
```

Open the FTDI console without taking ownership of the ESP32 console:

```sh
screen /dev/cu.usbserial-BG0107WG 115200
```

Exit `screen` with `Ctrl-A`, then `K`.

## 2. Record the initial radio and mesh state

Run these commands before changing logging:

```sh
iw dev
pgrep -af 'wpa_supplicant|hostapd'
batctl routing_algo
batctl meshif bat0 if
batctl meshif bat0 neighbors
batctl meshif bat0 originators
iw dev wlh0 station dump
iw dev wlh0 mpath dump
```

Expected H7608 state is:

- `wlh0` has type `mesh point`;
- `wlh0` is active under `bat0`;
- `bat0` uses `BATMAN_IV`, not `BATMAN_V`; and
- a working peer eventually appears in the station, mesh-path, BATMAN neighbor,
  and originator tables.

Morse's Linux driver can expose a translated 5 GHz frequency through `iw` for
an S1G channel. Do not compare that displayed frequency directly with the
ESP32's physical kHz value. Compare the configured country, S1G channel, and
bandwidth instead.

## 3. Enable raw `wpa_supplicant_s1g` debug

The H7608 binary uses the standard short option `-dd` for the most verbose
debug level. `--dd` is not a supported long option. Confirm on the target:

```sh
wpa_supplicant_s1g -h 2>&1 | grep -E -- '(^|[[:space:]])-d'
```

The H7608 starts the process from `/lib/netifd/wireless/morse.sh`. Back up that
file, add `-dd` to both background launch commands, and inspect the result:

```sh
cp -p /lib/netifd/wireless/morse.sh /root/morse.sh.before-dd
sed -i '/wpa_supplicant_s1g.* -dd -B$/! { /wpa_supplicant_s1g/ s/ -B$/ -dd -B/; }' /lib/netifd/wireless/morse.sh
grep -n 'wpa_supplicant_s1g.*-dd.*-B' /lib/netifd/wireless/morse.sh
```

Restart only the HaLow radio when its UCI radio section is known. Replace
`radio1` below if the H7608 uses another section:

```sh
uci show wireless | grep '=wifi-device'
wifi down radio1
wifi up radio1
```

Verify that the effective process command contains `-dd`:

```sh
pid="$(pgrep -f '/usr/sbin/wpa_supplicant_s1g' | head -n1)"
tr '\000' ' ' <"/proc/$pid/cmdline"
echo
```

The command should resemble:

```text
/usr/sbin/wpa_supplicant_s1g -t -D nl80211 -s -i wlh0 -c ... -dd -B
```

This is a runtime target change and can be lost after an H7608 firmware
upgrade. To undo it:

```sh
cp -p /root/morse.sh.before-dd /lib/netifd/wireless/morse.sh
wifi down radio1
wifi up radio1
```

## 4. Capture the raw peering exchange

Start the log before booting or resetting the ESP32 so discovery and the first
SAE/MPM frames are not missed:

```sh
logread -f
```

For a smaller live view, use:

```sh
logread -f | grep -E -i 'wpa_supplicant_s1g|wlh0|mesh|SAE|AMPE|MPM|peer|auth|action|nl80211|EAPOL'
```

If `tcpdump` is installed, capture full management/EAPOL packets at the same
time for later inspection:

```sh
tcpdump -i wlh0 -s 0 -U -w /tmp/wlh0-mesh.pcap
```

Minimal OpenWrt images may not include `tcpdump`. `batctl` can still prove
whether BATMAN-IV OGMs enter or leave the HaLow hard interface:

```sh
batctl tcpdump -c -n -p 1 wlh0
```

For an active BATMAN-IV interface this should show the H7608 originator about
once per `orig_interval`. After the ESP32 starts sending, it should also show
the ESP32 originator and the direct-link echo. Stop the live view with
`Ctrl-C`. This capture is especially useful for separating layers:

- H7608 originator present here but no ESP32 `stage=1 firmware_to_host` data
  entry: inspect the radio/firmware multicast receive path;
- ESP32 originator present here but absent from `batctl ... originators`:
  inspect OGM echo, TQ, and bidirectional-neighbor validation; and
- both originators visible and routes populated, but MQTT still fails:
  continue at BATMAN unicast/broadcast and application forwarding.

Stop it with `Ctrl-C`, then copy `/tmp/wlh0-mesh.pcap` off the router before a
reboot. A capture can contain MAC addresses and authentication traffic; do not
publish it with credentials or key-debug options enabled.

## 5. Read the failure in protocol order

Check the first point at which the two logs stop agreeing:

1. Both nodes use the same country, S1G channel, bandwidth, mesh ID, and
   security mode/passphrase.
2. H7608 sees the ESP32 beacon or probe and the ESP32 logs an RF receive entry
   such as `[MM_MAC_RX]` for the H7608 MAC.
3. SAE commit and confirm complete on both sides.
4. Mesh Peering Open and Confirm frames are exchanged; Link IDs agree.
5. The peer reaches `PLINK_ESTAB` and pairwise/group keys are installed.
6. The peer appears in `iw` station/path tables.
7. Only then diagnose BATMAN-IV neighbors and originators.

Useful ESP32 guarded logs in this branch include `[MM_RF_CMD]`, `[MM_RF_IF]`,
`[MM_MAC_RX]`, `[MM_MAC_RX_ROUTE]`, `[MM_MAC_RX_DROP]`, and `[MM_MAC_ROUTE]`.
If the ESP32 emits no `[MM_MAC_RX]` entry, the frame did not reach the host MAC
receive path; investigate channel/regulatory/antenna/firmware state before
SAE, MPM, or BATMAN.

BATMAN-IV is downstream of 802.11s peering. An empty BATMAN neighbor table is
expected until the peer link and encryption are established; changing BATMAN
cannot repair a missing beacon or failed SAE exchange.

## 6. Peer is established but unicast never arrives

A peer can reach `PLINK_ESTAB` and exchange BATMAN broadcast frames while the
Linux mesh point still has no unicast HWMP path to the ESP32. The characteristic
symptoms are:

- BATMAN neighbors and routes are present;
- Alfred requests leave the ESP32, but no Alfred push is received;
- the gateway repeatedly sends protected Action frames with frame control
  `0x40d0`; and
- after CCMP decryption, the body begins `0d 01 82 25`.

Those bytes identify Mesh Action category 13, Path Selection action 1, followed
by a PREQ element (`0x82`) with length 37. Check the PREQ target at action-body
offset 31. When it is the local ESP32 mesh MAC, the private UMAC must build a
PREP, protect the unicast Action frame with the peer MTK, and transmit it to the
PREQ sender. Logging or discarding the PREQ is insufficient: Linux queues
unicast traffic until the path is resolved.

Expected ESP32 evidence is:

```text
protected action decrypted ... category=13 action=1 len=41
HWMP PREQ target is local; PREP tx=0 ...
IPv6 neighbor advertisement: ESP_OK
EZGW1 gateway ... IPv4=10.41.71.1 ...
mesh DHCP address 10.41.71.x
```

Confirm the datapath from H7608:

```sh
ping -c 3 10.41.71.x
iperf -c 10.41.71.x -p 5001 -C -t 10 -i 1
```

The captured Linux PREQ layout is retained as a regression fixture in
`mm-iot-edgez/tests/test_edgez_mesh_hwmp.c`. Run the private UMAC suite with:

```sh
cmake --build build
ctest --test-dir build --output-on-failure
```

The response path must not be tied to the diagnostic log limit. PREQs can recur
when an HWMP path expires, so valid requests must continue receiving PREPs for
the lifetime of the peer association.
