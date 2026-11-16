import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EdgezMeshState, EdgezSensorSample } from "@edgez/react-native-sdk";
import { nodeNumFromSerial } from "../mesh-utils";
import type { StoredDevice } from "../profile-store";

/**
 * View model for the Collar product (gateway → collar nodes). Everything here
 * is derived from data the app already has: StoredDevice rows, live SDK mesh
 * state and sensor samples (local BLE or cloud telemetry). Unknown values stay
 * unknown — no battery percentages, default coordinates or invented health.
 */

const personTypes = new Set(["user", "device_type_user", "person", "hiker", "explorer"]);

export function isGateway(device: StoredDevice) {
  return device.kind === "h7608" || device.deviceType.trim().toLowerCase() === "gateway";
}

export function isPerson(device: StoredDevice) {
  return personTypes.has(device.deviceType.trim().toLowerCase()) || personTypes.has(device.iconStyle.trim().toLowerCase());
}

/** Collar nodes are the non-gateway, non-person mesh devices of the profile. */
export function collarDevices(devices: StoredDevice[]) {
  return devices.filter((device) => !isGateway(device) && !isPerson(device));
}

export type Freshness = "recent" | "stale" | "never";

/**
 * Report freshness. The SDK does not publish a per-model report period, so this
 * uses a conservative 30 minute window that covers the 60 s and 15 min periods
 * listed in the handoff. It is a display hint, not a calibrated offline rule.
 */
export const RECENT_REPORT_WINDOW_MS = 30 * 60 * 1000;

export type CollarNode = {
  device: StoredDevice;
  nodeNum: bigint | null;
  lastReportMs: number;
  freshness: Freshness;
  batteryVolts: number | null;
  batteryAtMs: number;
  rssiDbm: number | null;
  rssiAtMs: number;
  rssiReporter: bigint | null;
  latitude: number | null;
  longitude: number | null;
  locationAtMs: number;
  sampleCount: number;
};

export function buildCollarNodes(
  devices: StoredDevice[],
  meshState: EdgezMeshState | null,
  sensorSamples: ReadonlyMap<bigint, ReadonlyArray<EdgezSensorSample>>,
  now = Date.now(),
): CollarNode[] {
  return collarDevices(devices).map((device) => {
    const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
    const live = nodeNum === null ? undefined : meshState?.nodes.get(nodeNum);
    const samples = nodeNum === null ? [] : sensorSamples.get(nodeNum) ?? [];
    const storedSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    const latestSample = samples.length ? samples[samples.length - 1].timestampMs : 0;
    const lastReportMs = Math.max(live?.lastSeenMs ?? 0, Number.isFinite(storedSeen) ? storedSeen : 0, latestSample);

    let batteryVolts: number | null = null;
    let batteryAtMs = 0;
    let sampleLatitude: number | null = null;
    let sampleLongitude: number | null = null;
    let sampleLocationAt = 0;
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const sample = samples[index];
      if (batteryVolts === null && typeof sample.data.batteryVoltage === "number" && Number.isFinite(sample.data.batteryVoltage)) {
        batteryVolts = sample.data.batteryVoltage;
        batteryAtMs = sample.timestampMs;
      }
      if (sampleLatitude === null && typeof sample.data.latitude === "number" && typeof sample.data.longitude === "number") {
        sampleLatitude = sample.data.latitude;
        sampleLongitude = sample.data.longitude;
        sampleLocationAt = sample.timestampMs;
      }
      if (batteryVolts !== null && sampleLatitude !== null) break;
    }

    // HaLow link RSSI as reported by a mesh peer (never the phone's BLE RSSI).
    let rssiDbm: number | null = null;
    let rssiAtMs = 0;
    let rssiReporter: bigint | null = null;
    if (nodeNum !== null) {
      for (const link of meshState?.topologyLinks ?? []) {
        if (link.peerNodeNum !== nodeNum && link.reporterNodeNum !== nodeNum) continue;
        if (link.encodedRssi === 0 || link.lastSeenMs <= rssiAtMs) continue;
        rssiDbm = link.encodedRssi > 0 ? -link.encodedRssi : link.encodedRssi;
        rssiAtMs = link.lastSeenMs;
        rssiReporter = link.reporterNodeNum === nodeNum ? link.peerNodeNum : link.reporterNodeNum;
      }
    }

    const liveLocation = live?.latitude !== undefined && live?.longitude !== undefined;
    const latitude = sampleLatitude ?? (liveLocation ? live!.latitude! : device.latitude);
    const longitude = sampleLongitude ?? (liveLocation ? live!.longitude! : device.longitude);
    const locationAtMs = sampleLatitude !== null ? sampleLocationAt : liveLocation ? live!.lastSeenMs : latitude !== null ? storedSeen || 0 : 0;

    return {
      device,
      nodeNum,
      lastReportMs,
      freshness: !lastReportMs ? "never" : now - lastReportMs <= RECENT_REPORT_WINDOW_MS ? "recent" : "stale",
      batteryVolts,
      batteryAtMs,
      rssiDbm,
      rssiAtMs,
      rssiReporter,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      locationAtMs,
      sampleCount: samples.length,
    };
  });
}

export function groupSamples(samples: readonly EdgezSensorSample[]) {
  const grouped = new Map<bigint, EdgezSensorSample[]>();
  for (const sample of samples) grouped.set(sample.nodeNum, [...grouped.get(sample.nodeNum) ?? [], sample]);
  return grouped as ReadonlyMap<bigint, ReadonlyArray<EdgezSensorSample>>;
}

/* Local aliases: a phone-only label that never changes the hardware name or key. */

const aliasKey = (profileId: string) => `keepteen.node-aliases.v1:${profileId}`;

export async function loadNodeAliases(profileId: string): Promise<Record<string, string>> {
  try {
    const stored = await AsyncStorage.getItem(aliasKey(profileId));
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function saveNodeAliases(profileId: string, aliases: Record<string, string>) {
  await AsyncStorage.setItem(aliasKey(profileId), JSON.stringify(aliases));
}

export function displayName(node: CollarNode, aliases: Record<string, string>) {
  return aliases[node.device.id]?.trim() || node.device.name || node.device.serial;
}
