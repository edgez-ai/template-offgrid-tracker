import Ionicons from "@expo/vector-icons/Ionicons";
import { EdgezOrganicMap } from "@edgez/react-native-sdk";
import type { EdgezMapDownloadUpdate, EdgezMeshSession, EdgezMeshState, EdgezOrganicMapRef } from "@edgez/react-native-sdk";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BleLinkStatus } from "./ActiveProfileBleLink";
import { DeviceDetail } from "./DeviceComponents";
import { MeshMessages } from "./MeshMessages";
import { BleDebugModal } from "./SettingsScreens";
import { styles } from "./app-styles";
import { compatibleCurrentLocation } from "./location-utils";
import { coordinatesFromLocation, nodeNumFromSerial } from "./mesh-utils";
import { listProfileMessages } from "./profile-store";
import type { StoredDevice, StoredMessage, StoredProfile, StoredProvisioningRequest } from "./profile-store";

export function HomeMap({
  profile,
  devices,
  messages,
  provisioningRequests,
  bleStatus,
  meshLink,
  onAddDevice,
  onRemoveDevice,
  onMessagesChanged,
  onDevicesChanged,
  onProvisioningRequestsChanged,
  onResendMessage,
  onOpenSettings,
}: {
  profile: StoredProfile;
  devices: StoredDevice[];
  messages: StoredMessage[];
  provisioningRequests: StoredProvisioningRequest[];
  bleStatus: BleLinkStatus;
  meshLink: { session: EdgezMeshSession; state: EdgezMeshState } | null;
  onAddDevice: () => void;
  onRemoveDevice: (device: StoredDevice) => void;
  onMessagesChanged: () => Promise<void>;
  onDevicesChanged: () => Promise<void>;
  onProvisioningRequestsChanged: () => Promise<void>;
  onResendMessage: (message: StoredMessage) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const map = useRef<EdgezOrganicMapRef>(null);
  const profileCenter = coordinatesFromLocation(profile.location);
  const initialZoom = profileCenter ? 12 : 9;
  const mapZoom = useRef(initialZoom);
  const [region, setRegion] = useState("");
  const [download, setDownload] = useState<EdgezMapDownloadUpdate | null>(null);
  const [mapError, setMapError] = useState("");
  const [mapTheme, setMapTheme] = useState<"day" | "night">("day");
  const [debugOpen, setDebugOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<StoredDevice | null>(null);
  const [conversationPeer, setConversationPeer] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const locatedDevices = devices.filter((device) => device.latitude !== null && device.longitude !== null);
  const mapIconForDevice = (device: StoredDevice) => {
    switch ((device.iconStyle || device.deviceType).trim().toLowerCase()) {
      case "user":
      case "person":
      case "hiker":
      case "explorer": return "person" as const;
      case "dog": return "dog" as const;
      case "sheep": return "sheep" as const;
      case "cow": return "cow" as const;
      case "horse": return "horse" as const;
      case "tracker":
      case "unknown": return "tracker" as const;
      case "gateway": return "gateway" as const;
      case "beacon": return "beacon" as const;
      case "sensor": return "sensor" as const;
      case "relay": return "router" as const;
      default: return device.kind === "h7608" ? "gateway" as const : "tracker" as const;
    }
  };
  const mapNodes = [
    ...locatedDevices.map((device) => ({
      id: device.id,
      label: device.name,
      icon: mapIconForDevice(device),
      marker: device.marker || "default",
      latitude: device.latitude as number,
      longitude: device.longitude as number,
    })),
    ...(currentLocation ? [{ id: "current-location", label: "You", icon: "gps" as const, ...currentLocation }] : []),
  ];

  const toggleMapTheme = () => {
    const nextTheme = mapTheme === "day" ? "night" : "day";
    map.current?.setMapTheme(nextTheme);
    setMapTheme(nextTheme);
  };

  const centerOnCurrentLocation = async () => {
    if (locating) return;
    setLocating(true);
    setMapError("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is needed to show your current position.");
      if (!await Location.hasServicesEnabledAsync()) throw new Error("Turn on phone Location to show your current position.");
      const coordinates = await compatibleCurrentLocation();
      setCurrentLocation(coordinates);
      map.current?.setCamera({ ...coordinates, zoom: Math.max(mapZoom.current, 15) });
    } catch (caught) {
      setMapError(caught instanceof Error ? caught.message : "Could not determine the current location.");
    } finally {
      setLocating(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={mapTheme === "night" ? "light" : "dark"} />
      <View style={styles.mapCard}>
        <EdgezOrganicMap
          ref={map}
          nodes={mapNodes}
          lines={[]}
          centerLatitude={profileCenter?.latitude ?? 59.3293}
          centerLongitude={profileCenter?.longitude ?? 18.0686}
          zoom={initialZoom}
          enableMapDownloads
          style={styles.map}
          onCameraChanged={({ zoom }) => { mapZoom.current = zoom; }}
          onMapRegionAvailable={setRegion}
          onMapDownloadUpdate={(update) => {
            setRegion("");
            setDownload(update);
          }}
          onMapError={setMapError}
        />
        {region ? (
          <View style={styles.mapPrompt}>
            <Text style={styles.mapPromptTitle}>Save {region} offline?</Text>
            <Text style={styles.mapPromptText}>
              Download this region so the map keeps working without internet.
            </Text>
            <View style={styles.mapPromptActions}>
              <Pressable
                style={styles.mapDownloadButton}
                onPress={() => {
                  map.current?.downloadRegion(region);
                  setRegion("");
                }}
                accessibilityRole="button"
              >
                <Text style={styles.mapDownloadText}>DOWNLOAD</Text>
              </Pressable>
              <Pressable
                style={styles.mapLaterButton}
                onPress={() => {
                  map.current?.dismissDownloadRegion(region);
                  setRegion("");
                }}
                accessibilityRole="button"
              >
                <Text style={styles.mapLaterText}>NOT NOW</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {download && !download.finished ? (
          <View style={styles.mapNotice}>
            <Text style={styles.mapNoticeText}>
              {download.status}
              {download.progress === undefined ? "" : ` · ${Math.round(download.progress)}%`}
            </Text>
          </View>
        ) : null}

        {mapError ? (
          <Pressable style={[styles.mapNotice, styles.mapError]} onPress={() => setMapError("")}>
            <Text style={styles.mapNoticeText}>{mapError}</Text>
          </Pressable>
        ) : null}

        <View style={[styles.mapControls, region && styles.mapControlsRaised]}>
          <Pressable
            style={styles.mapControlButton}
            onPress={() => setMessagesOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open mesh messages"
          >
            <Ionicons name="chatbubble-ellipses-outline" size={22} color="white" />
            {meshLink?.state.nodes.size ? <View style={styles.messageAvailableDot} /> : null}
          </Pressable>
          <Pressable
            style={styles.mapControlButton}
            onPress={() => setDebugOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show BLE debug. ${bleStatus.label}`}
          >
            {bleStatus.phase === "preparing" || bleStatus.phase === "connecting"
              ? <ActivityIndicator color="#69cfc7" size="small" />
              : <Ionicons
                  name={bleStatus.phase === "ready" ? "bluetooth" : "bluetooth-outline"}
                  size={23}
                  color={bleStatus.phase === "ready"
                    ? "#69cfc7"
                    : bleStatus.phase === "connected"
                      ? "#f2c96d"
                      : bleStatus.phase === "error"
                        ? "#ff826f"
                        : "#90aaa7"}
                />}
            <View style={[
              styles.bleStatusDot,
              bleStatus.phase === "ready" && styles.bleStatusDotReady,
              bleStatus.phase === "connected" && styles.bleStatusDotConnected,
              bleStatus.phase === "error" && styles.bleStatusDotError,
            ]} />
          </Pressable>
          <Pressable
            style={styles.mapControlButton}
            onPress={toggleMapTheme}
            accessibilityRole="button"
            accessibilityLabel={`Use ${mapTheme === "day" ? "night" : "day"} map`}
          >
            <Ionicons name={mapTheme === "day" ? "moon-outline" : "sunny-outline"} size={22} color="white" />
          </Pressable>
          <Pressable
            style={[styles.mapControlButton, locating && styles.disabledButton]}
            onPress={() => void centerOnCurrentLocation()}
            disabled={locating}
            accessibilityRole="button"
            accessibilityLabel={locating ? "Finding current location" : "Show current location"}
          >
            {locating
              ? <ActivityIndicator color="white" size="small" />
              : <Ionicons name="locate-outline" size={23} color="white" />}
          </Pressable>
        </View>

        <Text style={styles.mapAttribution}>{locatedDevices.length} located devices · © OpenStreetMap contributors</Text>
      </View>

      <View style={styles.dashboardHeader} pointerEvents="box-none">
        <View />
        <View style={styles.headerActions}>
          <Pressable
            style={[styles.headerIconButton, styles.headerAddIconButton]}
            onPress={onAddDevice}
            accessibilityRole="button"
            accessibilityLabel="Add device"
          >
            <Ionicons name="add" size={26} color="white" />
          </Pressable>
          <Pressable
            style={styles.headerIconButton}
            onPress={onOpenSettings}
            accessibilityRole="button"
            accessibilityLabel="Open settings"
          >
            <Ionicons name="settings-outline" size={22} color="white" />
          </Pressable>
        </View>
      </View>
      <BleDebugModal
        visible={debugOpen}
        status={bleStatus}
        onClose={() => setDebugOpen(false)}
      />
      <MeshMessages
        visible={messagesOpen}
        profile={profile}
        profileId={profile.id}
        session={meshLink?.session ?? null}
        meshState={meshLink?.state ?? null}
        devices={devices}
        messages={messages}
        provisioningRequests={provisioningRequests}
        initialPeerSerial={conversationPeer}
        onMessagesChanged={onMessagesChanged}
        onDevicesChanged={onDevicesChanged}
        onProvisioningRequestsChanged={onProvisioningRequestsChanged}
        onResendMessage={onResendMessage}
        onShowDevice={setSelectedDevice}
        onRemoveDevice={onRemoveDevice}
        onClose={() => { setMessagesOpen(false); setConversationPeer(null); }}
      />
      <DeviceDetail
        device={selectedDevice}
        liveNode={selectedDevice ? (() => {
          const nodeNum = nodeNumFromSerial(selectedDevice.meshMacAddress || selectedDevice.serial);
          return nodeNum === null ? null : meshLink?.state.nodes.get(nodeNum) ?? null;
        })() : null}
        onClose={() => setSelectedDevice(null)}
        onMessage={(device) => {
          setSelectedDevice(null);
          setConversationPeer(device.meshMacAddress || device.serial);
          setMessagesOpen(true);
        }}
      />
    </SafeAreaView>
  );
}
