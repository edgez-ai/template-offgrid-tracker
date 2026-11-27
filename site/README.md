# Next.js operator portal

The Next.js client uses Appwrite email OTP sessions. It reads native status and
topology from the Devices API, current telemetry from TablesDB, and sensor history from Time Series.
Appwrite permissions restrict both data paths to the signed-in user. The
Function is not used for dashboard reads.
The Site lists Devices but never creates them or MQTT credentials. Onboarding
is exclusively available from the React Native app over BLE.

On desktop, the authenticated dashboard uses a master-detail layout with the
device list on the left and the selected device's current reading, multi-sensor
history chart, statistics, and recent raw MQTT readings on the right.
Sensor fields are discovered dynamically and operators can overlay any
combination in one chart. On mobile, devices are
shown as app-style cards and selecting one opens a full-screen detail view.
Both layouts require an explicit confirmation before deleting the selected
device through the authenticated Appwrite Devices API. The detail view also
draws the selected device's direct HaLow links from the Devices API topology
projection requested with `includeTopology=true`. Only links whose gateway report arrived within
the last two minutes are displayed.
The authenticated `/topology` page renders those same recent links as an
interactive force-directed network graph. Operators can pan, zoom, drag and
inspect devices, filter the graph by profile, compare RF RSSI, and see unresolved
HaLow peers alongside provisioned devices without requiring a Neo4j database.
HT-HC33 details offer MQTT OTA from a selected published BIN in Appwrite
Storage. The dashboard no longer discovers firmware through GitHub Releases.

## Firmware library and public USB flasher

The shared Storage bucket is `device-firmware`. Its bucket permissions are
empty and file security is enabled. Console administrators upload private
files under **Devices > Firmware**, then explicitly publish individual files
with `read("any")`. Guests cannot upload, modify, or delete firmware. Running
the template installer reconciles the bucket without changing file grants.

Filenames encode the board and version: `heltec-hc33__1.2.3.bin` for MQTT OTA,
and `nrf54l15__1.2.3.hex` or `.bin` for direct USB flashing. Upload dates are
recorded by Storage; file IDs distinguish uploads of the same version. Uploaded
files remain immutable versions: upload a new file instead of replacing an
existing binary. Source code stays in the firmware repository.

The public `/flash/` page requires no account. It lists published nRF54L15
images and uses desktop Chrome/Edge WebHID with a HID CMSIS-DAP probe. The
browser downloads the selected file and writes through SWD; it does not flash
the probe itself. HEX records are validated before programming. This page
supports English, 简体中文, 日本語, 한국어, and Deutsch with a persisted preference.
Use HTTPS in deployments and register the Site domain as an Appwrite Web
platform so anonymous Storage requests pass CORS. A same-origin iframe keeps
the existing flasher isolated from dashboard styles without granting another
origin access to the USB device.

Deploy the matching Appwrite Devices backend first: OTA accepts
`payload: {firmwareId}` and resolves only complete, published HT-HC33 BINs.
The server generates a `fw:<fileId>:<nonce>` request ID so the ingest Function
tracks the selected version, even if a different release is uploaded later.
Older clients may continue using the backend's legacy GitHub OTA URL path.
Do not treat a successful build as a successful physical flash; validate USB,
readback, device reboot, and OTA download on the target boards after deployment.

Appwrite filters device reads by the permissions assigned at creation, so the
portal only lists Devices readable by the signed-in creator.
