import assert from "node:assert/strict";
import { test } from "node:test";
import { topologyFromDevices } from "./device-status";

test("topology resolves only visible devices and preserves observation age", () => {
  const reportedAt = "2026-10-03T00:00:00.000Z";
  const links = topologyFromDevices([
    { $id: "gateway", serial: "G", metadata: { profileId: "profile" }, topology: { reportedAt, links: [
      { peerHalowMac: "02:11:22:33:44:55", ageMs: 890, rssi: -38 },
      { peerHalowMac: "02:AA:BB:CC:DD:EE", ageMs: 0 },
    ] } },
    { $id: "leaf", serial: "L", halowMac: "02:11:22:33:44:55" },
  ]);
  assert.equal(links[0].peerDeviceId, "leaf");
  assert.equal(links[0].lastSeenAt, "2026-10-02T23:59:59.110Z");
  assert.equal(links[1].peerDeviceId, "radio:02:AA:BB:CC:DD:EE");
  assert.equal(links[0].gatewayDeviceId, "gateway");
  assert.equal(links[0].kind, "mesh");
});

test("empty topology stays empty", () => {
  assert.deepEqual(topologyFromDevices([{ $id: "g", serial: "G", topology: { reportedAt: null, links: [] } }]), []);
});

test("PAwR sensors create a logical dotted gateway link", () => {
  const links = topologyFromDevices([
    { $id: "gateway", serial: "H7608", metadata: { profileId: "profile" } },
    { $id: "sensor", serial: "NRF54-01", gatewayDeviceId: "gateway", halowMac: "02:11:22:33:44:55", lastSeenAt: "2026-10-31T08:00:00.000Z" },
  ]);
  assert.deepEqual(links, [{
    $id: "gateway:pawr:sensor",
    profileId: "profile",
    gatewayDeviceId: "gateway",
    gatewayName: "H7608",
    gatewaySerial: "H7608",
    peerDeviceId: "sensor",
    peerName: "NRF54-01",
    peerSerial: "NRF54-01",
    peerRadioMac: "02:11:22:33:44:55",
    kind: "pawr",
    rssi: null,
    active: true,
    lastSeenAt: "2026-10-31T08:00:00.000Z",
    reportedAt: "2026-10-31T08:00:00.000Z",
  }]);
});
