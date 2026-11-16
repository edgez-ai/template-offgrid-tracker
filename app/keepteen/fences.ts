import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EdgezMapLine } from "@edgez/react-native-sdk";
import type { CollarNode } from "./collar-model";

/**
 * Geofences stored on this phone. The shape mirrors the cloud
 * `geofence-areas` / `geofence-rules` split (see function/src/main.js
 * evaluateGeofences) so a later sync adapter can map it 1:1:
 *   area  = { name, shape, geometry }
 *   rule  = { areaId, deviceIds, enterAlert, exitAlert }
 * `enabled` has no verified cloud field yet and is kept locally.
 * Nothing here is executed by the gateway; it is evaluated in-app against
 * recent positions only and presented as an "area reminder", not a confirmed
 * boundary-crossing event.
 */

export type FenceShape = "circle" | "oval" | "rectangle" | "polygon";
export type LatLon = { latitude: number; longitude: number };

export type FenceGeometry = {
  center: LatLon;
  radiusMeters?: number;
  radiusXMeters?: number;
  radiusYMeters?: number;
  widthMeters?: number;
  heightMeters?: number;
  rotationDegrees?: number;
  vertices?: LatLon[];
};

export type Fence = {
  id: string;
  profileId: string;
  name: string;
  shape: FenceShape;
  geometry: FenceGeometry;
  /** Explicit snapshot of node ids. Empty is invalid — it must never mean "whole profile". */
  deviceIds: string[];
  enterAlert: boolean;
  exitAlert: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

const storageKey = (profileId: string) => `keepteen.fences.v1:${profileId}`;

export async function loadFences(profileId: string): Promise<Fence[]> {
  try {
    const stored = await AsyncStorage.getItem(storageKey(profileId));
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is Fence => Boolean(item && typeof item === "object" && "id" in item)) : [];
  } catch {
    return [];
  }
}

export async function saveFences(profileId: string, fences: Fence[]) {
  await AsyncStorage.setItem(storageKey(profileId), JSON.stringify(fences));
}

export function newFenceId() {
  return `fence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Validation ------------------------------------------------------------- */

export type FenceError =
  | "fenceErrName" | "fenceErrNameBytes" | "fenceErrCenter" | "fenceErrSize"
  | "fenceErrRotation" | "fenceErrVertices" | "fenceErrSelfIntersect" | "fenceErrNodes" | "fenceErrAlert";

const MAX_NAME_BYTES = 64;
const MAX_SIZE_METERS = 50_000;

export function utf8Length(value: string) {
  return new TextEncoder().encode(value).length;
}

function validLatLon(point: LatLon | undefined) {
  return Boolean(point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180);
}

function validSize(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= MAX_SIZE_METERS;
}

export function validateFence(fence: Pick<Fence, "name" | "shape" | "geometry" | "deviceIds" | "enterAlert" | "exitAlert">): FenceError | null {
  const name = fence.name.trim();
  if (!name) return "fenceErrName";
  if (utf8Length(name) > MAX_NAME_BYTES) return "fenceErrNameBytes";
  const geometry = fence.geometry;
  if (fence.shape === "polygon") {
    const vertices = geometry.vertices ?? [];
    if (vertices.length < 3 || !vertices.every(validLatLon)) return "fenceErrVertices";
    if (selfIntersects(vertices)) return "fenceErrSelfIntersect";
  } else {
    if (!validLatLon(geometry.center)) return "fenceErrCenter";
    if (fence.shape === "circle" && !validSize(geometry.radiusMeters)) return "fenceErrSize";
    if (fence.shape === "oval" && (!validSize(geometry.radiusXMeters) || !validSize(geometry.radiusYMeters))) return "fenceErrSize";
    if (fence.shape === "rectangle" && (!validSize(geometry.widthMeters) || !validSize(geometry.heightMeters))) return "fenceErrSize";
    const rotation = geometry.rotationDegrees ?? 0;
    if (!Number.isFinite(rotation) || rotation < -360 || rotation > 360) return "fenceErrRotation";
  }
  if (!fence.deviceIds.length) return "fenceErrNodes";
  if (!fence.enterAlert && !fence.exitAlert) return "fenceErrAlert";
  return null;
}

/* Geometry --------------------------------------------------------------- */

const EARTH_RADIUS = 6_371_000;

/** Local equirectangular projection around `origin`, in metres. */
function toLocal(origin: LatLon, point: LatLon) {
  const latRad = origin.latitude * Math.PI / 180;
  return {
    x: (point.longitude - origin.longitude) * Math.PI / 180 * EARTH_RADIUS * Math.cos(latRad),
    y: (point.latitude - origin.latitude) * Math.PI / 180 * EARTH_RADIUS,
  };
}

function fromLocal(origin: LatLon, x: number, y: number): LatLon {
  const latRad = origin.latitude * Math.PI / 180;
  return {
    latitude: origin.latitude + y / EARTH_RADIUS * 180 / Math.PI,
    longitude: origin.longitude + x / (EARTH_RADIUS * Math.cos(latRad)) * 180 / Math.PI,
  };
}

function rotate(x: number, y: number, degrees: number) {
  const radians = -degrees * Math.PI / 180;
  return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) };
}

function segmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  const cross = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a); const d2 = cross(c, d, b); const d3 = cross(a, b, c); const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function selfIntersects(vertices: LatLon[]) {
  if (vertices.length < 4) return false;
  const origin = vertices[0];
  const points = vertices.map((vertex) => toLocal(origin, vertex));
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1)) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return true;
    }
  }
  return false;
}

export function fenceContains(fence: Fence, point: LatLon) {
  const { geometry } = fence;
  if (fence.shape === "polygon") {
    const vertices = geometry.vertices ?? [];
    if (vertices.length < 3) return false;
    const origin = vertices[0];
    const p = toLocal(origin, point);
    const poly = vertices.map((vertex) => toLocal(origin, vertex));
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const intersect = (poly[i].y > p.y) !== (poly[j].y > p.y) &&
        p.x < (poly[j].x - poly[i].x) * (p.y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  const local = toLocal(geometry.center, point);
  const { x, y } = rotate(local.x, local.y, -(geometry.rotationDegrees ?? 0));
  if (fence.shape === "circle") return Math.hypot(x, y) <= (geometry.radiusMeters ?? 0);
  if (fence.shape === "oval") {
    const rx = geometry.radiusXMeters ?? 0; const ry = geometry.radiusYMeters ?? 0;
    return rx > 0 && ry > 0 && (x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1;
  }
  return Math.abs(x) <= (geometry.widthMeters ?? 0) / 2 && Math.abs(y) <= (geometry.heightMeters ?? 0) / 2;
}

/** Outline as a closed polyline for EdgezOrganicMap `lines`. */
export function fenceOutline(fence: Fence): LatLon[] {
  const { geometry } = fence;
  if (fence.shape === "polygon") {
    const vertices = geometry.vertices ?? [];
    return vertices.length ? [...vertices, vertices[0]] : [];
  }
  const rotation = geometry.rotationDegrees ?? 0;
  const local: { x: number; y: number }[] = [];
  if (fence.shape === "rectangle") {
    const w = (geometry.widthMeters ?? 0) / 2; const h = (geometry.heightMeters ?? 0) / 2;
    local.push({ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }, { x: -w, y: -h });
  } else {
    const rx = fence.shape === "circle" ? geometry.radiusMeters ?? 0 : geometry.radiusXMeters ?? 0;
    const ry = fence.shape === "circle" ? geometry.radiusMeters ?? 0 : geometry.radiusYMeters ?? 0;
    for (let step = 0; step <= 48; step += 1) {
      const angle = step / 48 * Math.PI * 2;
      local.push({ x: Math.cos(angle) * rx, y: Math.sin(angle) * ry });
    }
  }
  return local.map(({ x, y }) => {
    const turned = rotate(x, y, rotation);
    return fromLocal(geometry.center, turned.x, turned.y);
  });
}

export function fenceLines(fences: Fence[], color: string): EdgezMapLine[] {
  return fences.filter((fence) => fence.enabled).map((fence) => ({ id: `fence:${fence.id}`, points: fenceOutline(fence), color }));
}

/* Area reminders --------------------------------------------------------- */

export type AreaReminder = {
  key: string;
  fence: Fence;
  node: CollarNode;
  kind: "outside" | "inside";
  atMs: number;
};

/** Only recent valid positions are evaluated; stale or missing data is never treated as "normal". */
export const FENCE_LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

export function areaReminders(fences: Fence[], nodes: CollarNode[], now = Date.now()): { reminders: AreaReminder[]; unevaluated: number } {
  const reminders: AreaReminder[] = [];
  let unevaluated = 0;
  for (const fence of fences) {
    if (!fence.enabled) continue;
    for (const deviceId of fence.deviceIds) {
      const node = nodes.find((item) => item.device.id === deviceId);
      if (!node || node.latitude === null || node.longitude === null || !node.locationAtMs || now - node.locationAtMs > FENCE_LOCATION_MAX_AGE_MS) {
        unevaluated += 1;
        continue;
      }
      const inside = fenceContains(fence, { latitude: node.latitude, longitude: node.longitude });
      if (!inside && fence.exitAlert) reminders.push({ key: `${fence.id}:${deviceId}:out`, fence, node, kind: "outside", atMs: node.locationAtMs });
      if (inside && fence.enterAlert) reminders.push({ key: `${fence.id}:${deviceId}:in`, fence, node, kind: "inside", atMs: node.locationAtMs });
    }
  }
  return { reminders, unevaluated };
}
