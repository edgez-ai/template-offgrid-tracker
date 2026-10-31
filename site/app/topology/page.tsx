"use client";

import { Account, Client, Models, Query, TablesDB } from "appwrite";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import ProfileSelector, { preferredProfileId, selectedProfileStorageKey } from "../ProfileSelector";
import type { CanvasLink, CanvasNode } from "./TopologyCanvas";

const TopologyCanvas = dynamic(() => import("./TopologyCanvas"), { ssr: false });

import { topologyFromDevices, type DeviceSystemState, type TopologyLink } from "../../lib/device-status";

type Device = DeviceSystemState & {
  $id: string;
  serial: string;
  name: string;
  enabled: boolean;
  status: string;
  metadata?: { profileId?: string; mqttGateway?: boolean; upstreamConnection?: string; icon?: string; markerColor?: string; [key: string]: unknown };
};
type Profile = Models.Row & { name: string };
type Telemetry = Models.Row & {
  deviceId: string;
  gatewayDeviceId?: string | null;
  halowMac?: string | null;
  icon?: string | null;
  markerColor?: string | null;
  receivedAt: string;
  payload: string;
};
type GraphEntity = {
  id: string;
  name: string;
  serial: string;
  profileId: string;
  halowMac: string;
  kind: "gateway" | "device" | "unresolved";
  online: boolean;
  lastSeenAt: string;
  gatewayDeviceId: string;
  icon: string;
  color: string;
  gatewayStatus: "online" | "offline" | null;
  mqttDirect: boolean;
};

const client = new Client()
  .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
  .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!);
const account = new Account(client);
const tables = new TablesDB(client);
const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!.replace(/\/+$/, "");
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!;
const databaseId = process.env.NEXT_PUBLIC_DATABASE_ID!;
const profileTableId = "profiles";
const telemetryTableId = process.env.NEXT_PUBLIC_TELEMETRY_TABLE_ID!;
const topologyRecentMs = 2 * 60 * 1000;
const mapMarkerColors: Record<string, string> = {
  red: "#E51B23", pink: "#FF4182", purple: "#9B24B2", deep_purple: "#6639BF",
  blue: "#0066CC", light_blue: "#249CF2", cyan: "#14BECD", teal: "#00A58C",
  green: "#3C8C3C", lime: "#93BF39", yellow: "#FFC800", orange: "#FF9600",
  deep_orange: "#F06432", brown: "#804633", gray: "#737373", blue_gray: "#597380",
};

function deviceColor(device: Device, latest?: Telemetry) {
  const saved = device.markerColor || latest?.markerColor || "";
  return mapMarkerColors[saved] || (device.enabled ? mapMarkerColors.blue : mapMarkerColors.gray);
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function relativeTime(value: string) {
  if (!value) return "No telemetry";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function payloadGatewayStatus(device?: Device) {
  const status = device?.gatewayStatus;
  return status === "online" || status === "offline" ? status : null;
}

function signalLabel(rssi?: number | null) {
  if (typeof rssi !== "number") return "RSSI unavailable";
  if (rssi >= -60) return "Excellent";
  if (rssi >= -75) return "Good";
  return "Weak";
}

async function listDevices() {
  const jwt = await account.createJWT();
  const response = await fetch(`${endpoint}/devices?includeTopology=true`, {
    headers: { "content-type": "application/json", "x-appwrite-project": projectId, "x-appwrite-jwt": jwt.jwt },
  });
  const payload = await response.json() as { devices?: Device[]; message?: string };
  if (!response.ok) throw new Error(payload.message || "Appwrite Devices request failed.");
  return payload.devices || [];
}

export default function TopologyPage() {
  const router = useRouter();
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [telemetry, setTelemetry] = useState<Telemetry[]>([]);
  const [links, setLinks] = useState<TopologyLink[]>([]);
  const [profileId, setProfileId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextDevices, profileRows, telemetryRows] = await Promise.all([
        listDevices(),
        tables.listRows<Profile>({ databaseId, tableId: profileTableId, queries: [Query.limit(100)] }),
        tables.listRows({ databaseId, tableId: telemetryTableId, queries: [Query.orderDesc("receivedAt"), Query.limit(500)] }),
      ]);
      setDevices(nextDevices);
      setProfiles([...profileRows.rows].sort((left, right) => left.name.localeCompare(right.name)));
      setTelemetry(telemetryRows.rows as unknown as Telemetry[]);
      setLinks(topologyFromDevices(nextDevices));
      setUpdatedAt(new Date().toISOString());
      setError("");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    account.get().then(async (current) => {
      if (!active) return;
      setUser(current);
      try {
        await refresh();
      } catch (caught) {
        if (active) setError(errorMessage(caught));
      }
    }).catch(() => {
      if (active) router.replace("/");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [refresh, router]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refresh().catch((caught) => setError(errorMessage(caught))), 5000);
    return () => window.clearInterval(timer);
  }, [refresh, user]);

  useEffect(() => {
    if (!user || !profiles.length) return;
    setProfileId((current) => profiles.some((profile) => profile.$id === current)
      ? current
      : preferredProfileId(user.$id, profiles, (user.prefs as { currentProfileId?: string }).currentProfileId));
  }, [profiles, user]);

  useEffect(() => {
    if (!user || !profileId || !profiles.some((profile) => profile.$id === profileId)) return;
    window.localStorage.setItem(selectedProfileStorageKey(user.$id), profileId);
  }, [profileId, profiles, user]);

  const latestByDevice = useMemo(() => {
    const latest = new Map<string, Telemetry>();
    for (const row of telemetry) if (!latest.has(row.deviceId)) latest.set(row.deviceId, row);
    return latest;
  }, [telemetry]);

  const graph = useMemo(() => {
    const profileLinks = links.filter((link) => link.profileId === profileId);
    const profileDevices = devices.filter((device) => device.metadata?.profileId === profileId);
    const gatewayIds = new Set<string>();
    for (const device of profileDevices) {
      const status = payloadGatewayStatus(device);
      if (device.metadata?.mqttGateway === true || status === "online" || status === "offline") gatewayIds.add(device.$id);
    }

    const entities = new Map<string, GraphEntity>();
    for (const device of profileDevices) {
      const latest = latestByDevice.get(device.$id);
      const online = Boolean(device.enabled && device.status === "online");
      const mqttDirect = Boolean(device.reportedAt && !device.gatewayDeviceId);
      const linkedGatewayId = device.gatewayDeviceId || "";
      const gatewayStatus = gatewayIds.has(device.$id)
        ? payloadGatewayStatus(device)
        : payloadGatewayStatus(devices.find((device) => device.$id === linkedGatewayId));
      entities.set(device.$id, {
        id: device.$id,
        name: device.name,
        serial: device.serial,
        profileId: device.metadata?.profileId || "",
        halowMac: device.halowMac || "",
        kind: gatewayIds.has(device.$id) ? "gateway" : "device",
        online,
        lastSeenAt: device.lastSeenAt || "",
        gatewayDeviceId: linkedGatewayId,
        icon: device.markerType || latest?.icon || "tracker",
        color: deviceColor(device, latest),
        gatewayStatus,
        mqttDirect,
      });
    }
    for (const link of profileLinks) {
      if (!entities.has(link.gatewayDeviceId)) entities.set(link.gatewayDeviceId, {
        id: link.gatewayDeviceId, name: link.gatewayName, serial: link.gatewaySerial, profileId: link.profileId,
        halowMac: "", kind: "gateway", online: true, lastSeenAt: link.reportedAt, gatewayDeviceId: "",
        icon: "gateway", color: mapMarkerColors.blue_gray,
        gatewayStatus: payloadGatewayStatus(devices.find((device) => device.$id === link.gatewayDeviceId)), mqttDirect: false,
      });
      if (!entities.has(link.peerDeviceId)) entities.set(link.peerDeviceId, {
        id: link.peerDeviceId, name: link.peerName, serial: link.peerSerial, profileId: link.profileId,
        halowMac: link.peerRadioMac, kind: "unresolved", online: true, lastSeenAt: link.lastSeenAt, gatewayDeviceId: link.gatewayDeviceId,
        icon: "beacon", color: mapMarkerColors.blue_gray,
        gatewayStatus: payloadGatewayStatus(devices.find((device) => device.$id === link.gatewayDeviceId)), mqttDirect: false,
      });
    }

    const graphNodes: CanvasNode[] = [...entities.values()].map((entity) => ({
      id: entity.id,
      label: entity.name.length > 18 ? `${entity.name.slice(0, 17)}…` : entity.name,
      kind: entity.kind,
      online: entity.online,
      icon: entity.icon,
      color: entity.color,
      gatewayStatus: entity.gatewayStatus,
      mqttDirect: entity.mqttDirect,
    }));
    const graphLinks: CanvasLink[] = profileLinks.map((link) => ({
      id: link.$id,
      from: link.gatewayDeviceId,
      to: link.peerDeviceId,
      rssi: link.rssi,
      kind: link.kind,
    }));
    return { entities, nodes: graphNodes, links: graphLinks, rows: profileLinks };
  }, [devices, profileId, latestByDevice, links]);

  useEffect(() => {
    if (selectedId && !graph.entities.has(selectedId)) setSelectedId("");
  }, [graph.entities, selectedId]);

  const selected = graph.entities.get(selectedId);
  const selectedLinks = selected ? graph.rows.filter((link) => link.gatewayDeviceId === selected.id || link.peerDeviceId === selected.id) : [];
  const onlineCount = [...graph.entities.values()].filter((node) => node.online).length;
  const gatewayCount = [...graph.entities.values()].filter((node) => node.kind === "gateway").length;
  const rssiValues = graph.rows.flatMap((link) => typeof link.rssi === "number" ? [link.rssi] : []);
  const averageRssi = rssiValues.length ? Math.round(rssiValues.reduce((sum, value) => sum + value, 0) / rssiValues.length) : null;
  const currentProfile = profiles.find((profile) => profile.$id === profileId);

  async function signOut() {
    await account.deleteSession({ sessionId: "current" });
    router.replace("/");
  }

  if (loading || !user) return <main className="shell topology-loading"><span className="spinner" /><p>Loading mesh topology…</p></main>;

  return <main className="shell topology-page">
    <header className="topbar"><span className="mark">L</span><strong>Offgrid Tracker</strong><nav className="topnav" aria-label="Primary navigation"><Link href="/">Devices</Link><Link className="active" href="/topology">Topology</Link></nav><ProfileSelector profiles={profiles} value={profileId} onChange={setProfileId} /><button className="link" onClick={() => void signOut()}>Sign out</button></header>
    <section className="topology-dashboard">
      <div className="topology-page-heading"><div><p className="eyebrow">{currentProfile?.name || "PROFILE"} · LIVE HALOW NETWORK</p><h1>Network topology</h1><p>Explore mesh peers and PAwR sensors. Scroll to zoom, drag the canvas to pan, and select a node for details.</p></div><div className="topology-controls"><button onClick={() => void refresh().catch((caught) => setError(errorMessage(caught)))} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh now"}</button><small>{updatedAt ? `Updated ${relativeTime(updatedAt)}` : "Waiting for data"}</small></div></div>
      <div className="topology-stats"><article><span>VISIBLE DEVICES</span><strong>{graph.entities.size}</strong></article><article><span>ONLINE NOW</span><strong>{onlineCount}</strong></article><article><span>GATEWAYS</span><strong>{gatewayCount}</strong></article><article><span>ACTIVE LINKS</span><strong>{graph.rows.length}</strong></article><article><span>AVERAGE SIGNAL</span><strong>{averageRssi === null ? "—" : `${averageRssi} dBm`}</strong></article></div>
      <div className="topology-workspace">
        <section className="topology-stage" aria-label="Interactive HaLow network topology">
          <div className="topology-legend"><span><i className="marker-color" />Marker color</span><span><i className="device-online" />Online halo</span><span><i className="device-offline" />Offline halo</span><span><i className="gateway" />Gateway ring</span><span><i className="gateway-status online" />Gateway online</span><span><i className="gateway-status offline" />Gateway offline</span><span><i className="mqtt" />MQTT direct</span><span><b className="link mesh" />Mesh</span><span><b className="link pawr" />PAwR</span><span><b className="signal excellent" />Excellent</span><span><b className="signal good" />Good</span><span><b className="signal weak" />Weak</span></div>
          {graph.nodes.length ? <TopologyCanvas nodes={graph.nodes} links={graph.links} selectedId={selectedId} onSelect={setSelectedId} /> : <div className="topology-zero"><strong>No topology data</strong><span>No devices or active HaLow links are visible for this profile.</span></div>}
        </section>
        <aside className="topology-inspector">
          {selected ? <><p className="eyebrow">SELECTED NODE</p><h2>{selected.name}</h2><code>{selected.serial}</code><div className="inspector-grid"><div><span>ROLE</span><strong>{selected.kind === "gateway" ? "MQTT gateway" : selected.kind === "unresolved" ? "Observed peer" : selected.gatewayDeviceId ? "PAwR sensor" : "Mesh device"}</strong></div><div><span>STATE</span><strong className={selected.online ? "available" : "unavailable"}>{selected.online ? "Online" : "Offline"}</strong></div>{selected.gatewayStatus && <div><span>GATEWAY STATUS</span><strong className={selected.gatewayStatus === "online" ? "available" : "unavailable"}>{selected.gatewayStatus === "online" ? "Online" : "Offline"}</strong></div>}<div><span>MQTT CLIENT</span><strong>{selected.mqttDirect ? "Direct" : selected.gatewayDeviceId ? "Via gateway" : "Not reported"}</strong></div><div><span>HALOW MAC</span><strong>{selected.halowMac || "Not reported"}</strong></div><div><span>LAST TELEMETRY</span><strong>{relativeTime(selected.lastSeenAt)}</strong></div><div><span>PROFILE</span><strong>{currentProfile?.name || selected.profileId || "Unassigned"}</strong></div></div><h3>{selectedLinks.length} direct link{selectedLinks.length === 1 ? "" : "s"}</h3><div className="inspector-links">{selectedLinks.map((link) => { const peerName = link.gatewayDeviceId === selected.id ? link.peerName : link.gatewayName; return <article key={link.$id}><div><strong>{peerName}</strong><span>{relativeTime(link.lastSeenAt)}</span></div><b>{typeof link.rssi === "number" ? `${link.rssi} dBm` : link.kind === "pawr" ? "PAwR" : "—"}<small>{link.kind === "pawr" ? "Sensor link" : signalLabel(link.rssi)}</small></b></article>; })}{!selectedLinks.length && <p>No active links in the last two minutes.</p>}</div></> : <div className="inspector-empty"><span>↖</span><strong>Select a node</strong><p>Device identity, gateway status, HaLow MAC, and direct RF links will appear here.</p></div>}
        </aside>
      </div>
      <section className="topology-table-card"><header><div><p className="eyebrow">RELATIONSHIPS</p><h2>Active HaLow links</h2></div><span>REPORTING WINDOW · 2 MINUTES</span></header><div className="topology-table-scroll"><table><thead><tr><th>Gateway</th><th>Peer</th><th>Link</th><th>Peer HaLow MAC</th><th>RF signal</th><th>Quality</th><th>Last seen</th></tr></thead><tbody>{graph.rows.map((link) => <tr key={link.$id}><td>{link.gatewayName}<br /><code>{link.gatewaySerial}</code></td><td>{link.peerName}<br /><code>{link.peerSerial}</code></td><td><span className={`link-kind ${link.kind}`}>{link.kind === "pawr" ? "PAwR" : "Mesh"}</span></td><td><code>{link.peerRadioMac || "—"}</code></td><td>{typeof link.rssi === "number" ? `${link.rssi} dBm` : "—"}</td><td><span className={`signal-pill ${typeof link.rssi !== "number" ? "unknown" : link.rssi >= -60 ? "excellent" : link.rssi >= -75 ? "good" : "weak"}`}>{link.kind === "pawr" ? "Sensor" : signalLabel(link.rssi)}</span></td><td>{relativeTime(link.lastSeenAt)}</td></tr>)}</tbody></table>{!graph.rows.length && <p className="empty">No active relationships reported.</p>}</div></section>
    </section>
    {error && <p className="error" role="alert">{error}</p>}
  </main>;
}
