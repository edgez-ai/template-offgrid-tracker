"use client";

import { Account, Models, Query, TablesDB } from "appwrite";
import { useCallback, useEffect, useMemo, useState } from "react";

type Photo = Models.Row & { deviceId: string; fileId: string; receivedAt: string;
  width: number; height: number; totalBytes: number };
type Props = { deviceId: string; firmwareTarget?: string; account: Account; tables: TablesDB;
  endpoint: string; projectId: string; databaseId: string };
const resolutions = ["Capture disabled", "160 × 120", "320 × 240", "640 × 480", "1024 × 768",
  "1280 × 720", "1280 × 960", "1600 × 1200", "1920 × 1080", "2304 × 1296"];
const message = (error: unknown) => error instanceof Error ? error.message : "Could not load camera data.";
type ReadPhoto = (fileId: string, signal: AbortSignal) => Promise<Blob>;

function PhotoCard({ photo, read }: { photo: Photo; read: ReadPhoto }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setUrl(""); setError("");
    void read(photo.fileId, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch((caught) => { if (!controller.signal.aborted) setError(message(caught)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.fileId, read, attempt]);
  return <article className="camera-photo">
    {url ? <button className="camera-thumbnail" onClick={() => setExpanded(true)} aria-label="Open camera photo">
      {/* Private, authenticated blob URL; Next's public image optimizer cannot access this file. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={`Camera photo received ${new Date(photo.receivedAt).toLocaleString()}`} width={photo.width} height={photo.height} />
    </button> : <div className="camera-placeholder">{error ? <><p role="alert">{error}</p><button onClick={() => setAttempt((value) => value + 1)}>Retry</button></> : "Loading photo…"}</div>}
    <time dateTime={photo.receivedAt}>{new Date(photo.receivedAt).toLocaleString()}</time>
    <small>{photo.width} × {photo.height} · {Math.round(photo.totalBytes / 1024)} KB</small>
    {expanded && url && <dialog open className="camera-viewer" aria-label="Camera photo" onKeyDown={(event) => { if (event.key === "Escape") setExpanded(false); }}>
      <header><time>{new Date(photo.receivedAt).toLocaleString()}</time><button autoFocus onClick={() => setExpanded(false)}>Close</button></header>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Camera photo at full size" />
      <a href={url} download={`${photo.deviceId}-${photo.$id}.jpg`}>Save JPEG</a>
    </dialog>}
  </article>;
}

export default function CameraPanel({ deviceId, firmwareTarget, account, tables, endpoint, projectId, databaseId }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [cursors, setCursors] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [galleryError, setGalleryError] = useState("");
  const [controls, setControls] = useState(/vc0706|camera/i.test(firmwareTarget || ""));
  const [interval, setIntervalSeconds] = useState("60");
  const [resolution, setResolution] = useState("3");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const auth = useMemo(() => {
    let cached: Promise<string> | null = null, expires = 0;
    return async () => {
      if (!cached || Date.now() >= expires) {
        expires = Date.now() + 10 * 60 * 1000;
        cached = account.createJWT().then((result) => result.jwt).catch((error) => { cached = null; throw error; });
      }
      return cached;
    };
  }, [account]);
  const readPhoto = useCallback<ReadPhoto>(async (fileId, signal) => {
    const jwt = await auth();
    const response = await fetch(`${endpoint}/storage/buckets/camera-images/files/${encodeURIComponent(fileId)}/view`, {
      headers: { "x-appwrite-project": projectId, "x-appwrite-jwt": jwt }, cache: "no-store", signal,
    });
    if (!response.ok) throw new Error(`Could not load photo (${response.status}).`);
    const blob = await response.blob();
    if (blob.size > 524288 || blob.type !== "image/jpeg") throw new Error("Invalid camera photo.");
    return blob;
  }, [auth, endpoint, projectId]);
  const cursor = cursors.at(-1);
  useEffect(() => {
    let active = true, running = false;
    setLoading(true); setGalleryError(""); setPhotos([]);
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const result = await tables.listRows<Photo>({ databaseId, tableId: "camera-images", queries: [
          Query.equal("deviceId", [deviceId]), Query.equal("status", ["complete"]),
          Query.orderDesc("receivedAt"), Query.limit(13), ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ] });
        if (!active) return;
        setPhotos(result.rows.slice(0, 12)); setHasMore(result.rows.length > 12); setGalleryError("");
      } catch (caught) { if (active) setGalleryError(message(caught)); }
      finally { running = false; if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [cursor, databaseId, deviceId, tables]);

  useEffect(() => {
    if (!controls) return;
    const controller = new AbortController();
    setSettingsLoading(true); setSettingsError("");
    void auth().then(async (jwt) => {
      const response = await fetch(`${endpoint}/devices/${encodeURIComponent(deviceId)}/downlinks?limit=50`, {
        headers: { "x-appwrite-project": projectId, "x-appwrite-jwt": jwt }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Could not read camera settings (${response.status}).`);
      const result = await response.json() as { downlinks?: { command: string; status: string;
        payload?: { samplingIntervalMs?: unknown; blockSamplingCount?: unknown } }[] };
      if (controller.signal.aborted) return;
      const requested = result.downlinks?.find((item) => item.command === "sensor.settings" &&
        typeof item.payload?.samplingIntervalMs === "number" && typeof item.payload?.blockSamplingCount === "number");
      if (requested) {
        setIntervalSeconds(String(Number(requested.payload!.samplingIntervalMs) / 1000));
        setResolution(String(requested.payload!.blockSamplingCount)); setStatus(requested.status);
      } else setStatus("Device defaults");
    }).catch((caught) => { if (!controller.signal.aborted) setSettingsError(message(caught)); })
      .finally(() => { if (!controller.signal.aborted) setSettingsLoading(false); });
    return () => controller.abort();
  }, [auth, controls, deviceId, endpoint, projectId]);

  async function save() {
    const seconds = Number(interval), index = Number(resolution);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 || !Number.isInteger(index) || index < 0 || index > 9) {
      setSettingsError("Choose a resolution and an interval from 1 to 3600 seconds."); return;
    }
    setSaving(true); setSettingsError("");
    try {
      const jwt = await auth();
      const response = await fetch(`${endpoint}/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: "POST", headers: { "content-type": "application/json", "x-appwrite-project": projectId, "x-appwrite-jwt": jwt },
        body: JSON.stringify({ command: "sensor.settings", payload: { samplingIntervalMs: seconds * 1000, blockSamplingCount: index } }),
      });
      if (!response.ok) throw new Error(`Could not update camera settings (${response.status}).`);
      setStatus("Queued · applies on the next beacon");
    } catch (caught) { setSettingsError(message(caught)); }
    finally { setSaving(false); }
  }

  return <section className="camera-panel">
    <header><div><h3>Camera photos</h3><p>Newest first · Received time</p></div><button className="secondary" onClick={() => setControls((value) => !value)}>{controls ? "Hide controls" : "Camera controls"}</button></header>
    {controls && <form className="camera-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Photo interval · seconds<input type="number" min="1" max="3600" step="1" required value={interval} onChange={(event) => setIntervalSeconds(event.target.value)} /></label>
      <label>Resolution<select value={resolution} onChange={(event) => setResolution(event.target.value)}>{resolutions.map((label, index) => <option key={index} value={index}>{label}</option>)}</select></label>
      <button disabled={saving || settingsLoading}>{saving ? "Updating…" : settingsLoading ? "Loading…" : "Update camera"}</button>
      <p>Delivered after the next beacon. Disabling capture keeps beacons and settings updates enabled.</p>
      {status && <p role="status">{status}</p>}{settingsError && <p className="inline-error" role="alert">{settingsError}</p>}
    </form>}
    {galleryError && <p className="inline-error" role="alert">{galleryError}</p>}
    {loading && <p className="empty">Loading photos…</p>}
    {!loading && !photos.length && !galleryError && <p className="empty">Waiting for the first photo.</p>}
    <div className="camera-grid">{photos.map((photo) => <PhotoCard key={photo.$id} photo={photo} read={readPhoto} />)}</div>
    <nav className="camera-paging" aria-label="Camera photo pages">
      {cursors.length > 0 && <button className="secondary" disabled={loading} onClick={() => setCursors((current) => current.slice(0, -1))}>Newer</button>}
      {hasMore && <button className="secondary" disabled={loading} onClick={() => setCursors((current) => [...current, photos.at(-1)!.$id])}>Older</button>}
    </nav>
  </section>;
}
