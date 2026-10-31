export type DeviceSystemState = {
  markerType?: string | null;
  markerColor?: string | null;
  location?: [number, number] | null;
  firmwareVersion?: string | null;
  halowMac?: string | null;
  gatewayDeviceId?: string | null;
  gatewayStatus?: string | null;
  wifiEnabled?: boolean | null;
  reportedAt?: string | null;
  lastSeenAt?: string | null;
  topology?: { reportedAt: string | null; links: { peerHalowMac: string; ageMs: number; rssi?: number }[] } | null;
};

export type TopologyLink = {
  $id: string; profileId: string; gatewayDeviceId: string; gatewayName: string; gatewaySerial: string;
  peerDeviceId: string; peerName: string; peerSerial: string; peerRadioMac: string; rssi?: number | null;
  kind: "mesh" | "pawr"; active: boolean; lastSeenAt: string; reportedAt: string;
};

type DeviceIdentity = DeviceSystemState & { $id: string; name?: string; serial: string; metadata?: { profileId?: string } };

// Resolve only identities visible through the Devices API. Unknown radios retain their MAC identity.
export function topologyFromDevices(devices: DeviceIdentity[]): TopologyLink[] {
  const byMac = new Map(devices.filter((device) => device.halowMac).map((device) => [device.halowMac!.toUpperCase(), device]));
  const byId = new Map(devices.map((device) => [device.$id, device]));
  const meshLinks = devices.flatMap((device) => {
    const snapshot = device.topology;
    if (!snapshot?.reportedAt || !Number.isFinite(Date.parse(snapshot.reportedAt))) return [];
    const reportedAt = snapshot.reportedAt;
    return snapshot.links.map((link) => {
      const mac = link.peerHalowMac.toUpperCase();
      const peer = byMac.get(mac);
      return {
        $id: `${device.$id}:${mac}`, profileId: device.metadata?.profileId || "",
        gatewayDeviceId: device.$id, gatewayName: device.name || device.serial, gatewaySerial: device.serial,
        peerDeviceId: peer?.$id || `radio:${mac}`, peerName: peer?.name || peer?.serial || mac, peerSerial: peer?.serial || mac,
        peerRadioMac: mac, rssi: link.rssi, kind: "mesh" as const, active: true,
        lastSeenAt: new Date(Date.parse(reportedAt) - link.ageMs).toISOString(),
        reportedAt,
      };
    });
  });
  const meshPairs = new Set(meshLinks.map((link) => `${link.gatewayDeviceId}:${link.peerDeviceId}`));
  const pawrLinks = devices.flatMap((device): TopologyLink[] => {
    if (!device.gatewayDeviceId || !device.lastSeenAt || !Number.isFinite(Date.parse(device.lastSeenAt))) return [];
    const gateway = byId.get(device.gatewayDeviceId);
    if (!gateway || meshPairs.has(`${gateway.$id}:${device.$id}`)) return [];
    return [{
      $id: `${gateway.$id}:pawr:${device.$id}`,
      profileId: device.metadata?.profileId || gateway.metadata?.profileId || "",
      gatewayDeviceId: gateway.$id,
      gatewayName: gateway.name || gateway.serial,
      gatewaySerial: gateway.serial,
      peerDeviceId: device.$id,
      peerName: device.name || device.serial,
      peerSerial: device.serial,
      peerRadioMac: device.halowMac?.toUpperCase() || "",
      kind: "pawr",
      rssi: null,
      active: true,
      lastSeenAt: device.lastSeenAt,
      reportedAt: device.lastSeenAt,
    }];
  });
  return [...meshLinks, ...pawrLinks];
}
