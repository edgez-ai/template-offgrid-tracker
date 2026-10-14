import { useEdgezMeshSession } from "@edgez/react-native-sdk";
import type { EdgezMeshConfig, EdgezMeshNode, EdgezMeshSession, EdgezMeshState } from "@edgez/react-native-sdk";
import * as Location from "expo-location";
import React, { useEffect, useRef, useState } from "react";
import { bandwidthForChannel, channelsForCountry } from "./halowChannels";
import { coordinatesFromLocation, messagesByNode, storedDeviceNode } from "./mesh-utils";
import { listProfileDevices, listProfileMessages, profileIdentity } from "./profile-store";
import type { StoredProfile } from "./profile-store";
import type { LocationMode } from "./app-settings";

type BeaconLocation = { latitude: number; longitude: number };

function meshConfig(profile: StoredProfile, location?: BeaconLocation): EdgezMeshConfig {
  const channel = channelsForCountry(profile.country).find(({ number }) => number === profile.halowChannel);
  return {
    identity: profileIdentity(profile),
    countryCode: profile.country,
    meshId: profile.meshId,
    passphrase: profile.meshPassphrase,
    meshBandwidthMhz: channel ? bandwidthForChannel(channel) : 0,
    meshFrequencyKhz: channel ? Math.round(channel.frequencyMHz * 1000) : 0,
    beacon: {
      shareLocation: Boolean(location),
      latitude: location?.latitude,
      longitude: location?.longitude,
      locationTimestampMs: location ? Date.now() : undefined,
    },
  };
}

export type BleLinkStatus = {
  phase: "not-selected" | "preparing" | "disconnected" | "connecting" | "connected" | "ready" | "error";
  label: string;
  details: string[];
  halowLinkUp: boolean | null;
  updatedAt: number;
};

export function ActiveProfileBleLink({
  profile,
  locationMode,
  onStatusChange,
  onMeshChange,
}: {
  profile: StoredProfile;
  locationMode: LocationMode;
  onStatusChange: (status: BleLinkStatus) => void;
  onMeshChange: (value: { session: EdgezMeshSession; state: EdgezMeshState }) => void;
}) {
  const sessionRef = useRef<EdgezMeshSession | null>(null);
  const retryDelayMs = useRef(500);
  const [configured, setConfigured] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [liveLocationError, setLiveLocationError] = useState("");
  const [session, state] = useEdgezMeshSession({
    onIncomingMessage: (message, sender) => {
      void sessionRef.current?.sdk.showIncomingMessageNotification(message, sender).catch(() => undefined);
    },
  });
  sessionRef.current = session;

  useEffect(() => onMeshChange({ session, state }), [onMeshChange, session, state]);

  useEffect(() => {
    let cancelled = false;
    setConfigured(false);
    setSetupError("");
    setLiveLocationError("");
    void (async () => {
      if (!profile.bleDeviceId) return;
      const [storedMessages, storedDevices] = await Promise.all([
        listProfileMessages(profile.id),
        listProfileDevices(profile.id),
      ]);
      const cachedNodes = new Map<bigint, EdgezMeshNode>();
      for (const device of storedDevices) {
        const node = storedDeviceNode(device);
        if (node) cachedNodes.set(node.nodeNum, node);
      }
      session.restoreCachedMeshData({
        ...(cachedNodes.size ? { nodes: cachedNodes } : {}),
        ...(storedMessages.length ? { conversations: messagesByNode(storedMessages) } : {}),
      });
      let coordinates = locationMode === "fixed" ? coordinatesFromLocation(profile.location) ?? undefined : undefined;
      if (locationMode === "live") {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status === "granted") {
          const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          coordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        } else {
          setLiveLocationError("Phone location permission is required for Live mode");
        }
      }
      await session.initializeMesh(meshConfig(profile, coordinates));
      await session.sdk.requestNotificationPermission().catch(() => false);
      if (!cancelled) setConfigured(true);
    })().catch((caught) => {
      if (!cancelled) {
        setConfigured(false);
        setSetupError(caught instanceof Error ? caught.message : "BLE setup failed");
      }
    });
    return () => {
      cancelled = true;
      void session.disconnect().catch(() => undefined);
    };
  }, [locationMode, profile, session]);

  useEffect(() => {
    if (locationMode !== "live" || !configured || !state.bleReady || !profile.bleDeviceId) return;
    let cancelled = false;
    let subscription: Location.LocationSubscription | undefined;
    void (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        if (!cancelled) setLiveLocationError("Phone location permission is required for Live mode");
        return;
      }
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 15_000, distanceInterval: 10 },
        (position) => {
          if (cancelled) return;
          setLiveLocationError("");
          void session.initializeMesh(meshConfig(profile, {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          })).catch((caught) => {
            if (!cancelled) setLiveLocationError(caught instanceof Error ? caught.message : "Could not update the live beacon location");
          });
        },
      );
    })().catch((caught) => {
      if (!cancelled) setLiveLocationError(caught instanceof Error ? caught.message : "Could not watch the phone location");
    });
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [configured, locationMode, profile, session, state.bleReady]);

  useEffect(() => {
    if (state.connection !== "none") {
      retryDelayMs.current = 500;
      return;
    }
    if (!configured || !profile.bleDeviceId || state.bleConnecting) return;
    const delay = retryDelayMs.current;
    const retry = setTimeout(() => {
      void session.connectBle(profile.bleDeviceId).catch(() => {
        retryDelayMs.current = Math.min(delay * 2, 30_000);
      });
    }, delay);
    return () => clearTimeout(retry);
  }, [configured, profile.bleDeviceId, session, state.bleConnecting, state.connection]);

  useEffect(() => {
    const details = [
      `Device: ${profile.bleDeviceName || profile.bleDeviceId || "Not selected"}`,
      `Device ID: ${profile.bleDeviceId || "Not selected"}`,
      `Connection: ${state.connection}`,
      `Control channel: ${state.bleReady ? "ready" : "not ready"}`,
      `Connecting: ${state.bleConnecting ? "yes" : "no"}`,
      `Session: ${state.statusLine}`,
      `Location: ${locationMode === "off" ? "off" : locationMode === "fixed" ? "fixed" : liveLocationError || "live phone updates"}`,
      ...(state.status ? [
        `Firmware: ${state.status.firmwareVersion || "unknown"}`,
        `License: ${state.status.licenseStatus}`,
        `HaLow stack: ${state.status.stackInitialized ? "initialized" : "not initialized"}`,
        `HaLow link: ${state.status.linkUp ? "up" : "down"}`,
        `Route: ${state.status.routeReady ? "ready" : "not ready"}`,
        `Mesh ID: ${state.status.meshId || "unknown"}`,
        `MAC: ${state.status.macAddress ? state.status.macAddress.toString(16).padStart(12, "0").toUpperCase() : "unknown"}`,
      ] : ["Device status: waiting"]),
    ];
    const liveStatus = { details, halowLinkUp: state.status ? state.status.linkUp : null, updatedAt: Date.now() };
    if (!profile.bleDeviceId) onStatusChange({ phase: "not-selected", label: "No BLE device selected", ...liveStatus });
    else if (setupError) onStatusChange({ phase: "error", label: setupError, ...liveStatus });
    else if (!configured) onStatusChange({ phase: "preparing", label: "Preparing BLE connection", ...liveStatus });
    else if (state.bleReady) onStatusChange({ phase: "ready", label: "BLE control channel ready", ...liveStatus });
    else if (state.connection === "ble") onStatusChange({ phase: "connected", label: "BLE connected", ...liveStatus });
    else if (state.bleConnecting) onStatusChange({ phase: "connecting", label: "Connecting to BLE device", ...liveStatus });
    else onStatusChange({ phase: "disconnected", label: "BLE disconnected · retrying", ...liveStatus });
  }, [configured, liveLocationError, locationMode, onStatusChange, profile.bleDeviceId, profile.bleDeviceName, setupError, state.bleConnecting, state.bleReady, state.connection, state.status, state.statusLine]);

  return null;
}
