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
import type { CloudConnectionState } from "./cloud-auth";
import { listProfileMessages } from "./profile-store";
import type { StoredDevice, StoredMessage, StoredProfile, StoredProvisioningRequest } from "./profile-store";

type MapCamera = { latitude: number; longitude: number; zoom: number };

const MAX_MERCATOR_LATITUDE = 85.05112878;

function mercatorPoint(latitude: number, longitude: number, zoom: number) {
  const clampedLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const latitudeRadians = clampedLatitude * Math.PI / 180;
  const worldSize = 256 * 2 ** zoom;
  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) / 2 * worldSize,
    worldSize,
  };
}

function deviceScreenPoint(
  device: StoredDevice,
  camera: MapCamera,
  size: { width: number; height: number },
) {
  if (device.latitude === null || device.longitude === null || size.width <= 0 || size.height <= 0) return null;
  const center = mercatorPoint(camera.latitude, camera.longitude, camera.zoom);
  const point = mercatorPoint(device.latitude, device.longitude, camera.zoom);
  let deltaX = point.x - center.x;
  if (deltaX > center.worldSize / 2) deltaX -= center.worldSize;
  if (deltaX < -center.worldSize / 2) deltaX += center.worldSize;
  return { x: size.width / 2 + deltaX, y: size.height / 2 + point.y - center.y };
}

export function HomeMap({
  profile,
  devices,
  messages,
  provisioningRequests,
  bleStatus,
  cloudStatus,
  meshLink,
  onRemoveDevice,
  onMessagesChanged,
  onDevicesChanged,
  onProvisioningRequestsChanged,
  onResendMessage,
  onCloudPress,
  onOpenSettings,
}: {
  profile: StoredProfile;
  devices: StoredDevice[];
  messages: StoredMessage[];
  provisioningRequests: StoredProvisioningRequest[];
  bleStatus: BleLinkStatus;
  cloudStatus: CloudConnectionState;
  meshLink: { session: EdgezMeshSession; state: EdgezMeshState } | null;
  onRemoveDevice: (device: StoredDevice) => void;
  onMessagesChanged: () => Promise<void>;
  onDevicesChanged: () => Promise<void>;
  onProvisioningRequestsChanged: () => Promise<void>;
  onResendMessage: (message: StoredMessage) => Promise<void>;
  onCloudPress: () => void;
  onOpenSettings: () => void;
}) {
  const map = useRef<EdgezOrganicMapRef>(null);
  const profileCenter = coordinatesFromLocation(profile.location);
  const initialZoom = profileCenter ? 12 : 9;
  const initialCamera = {
    latitude: profileCenter?.latitude ?? 59.3293,
    longitude: profileCenter?.longitude ?? 18.0686,
    zoom: initialZoom,
  };
  const mapZoom = useRef(initialZoom);
  const [region, setRegion] = useState("");
  const [download, setDownload] = useState<EdgezMapDownloadUpdate | null>(null);
  const [mapError, setMapError] = useState("");
  const [mapTheme, setMapTheme] = useState<"day" | "night">("day");
  const [debugOpen, setDebugOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<StoredDevice | null>(null);
  const [selectedMapDeviceId, setSelectedMapDeviceId] = useState<string | null>(null);
  const [conversationPeer, setConversationPeer] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [mapCamera, setMapCamera] = useState<MapCamera>(initialCamera);
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });
  const locatedDevices = devices.filter((device) => device.latitude !== null && device.longitude !== null);
  const selectedMapDevice = selectedMapDeviceId === null
    ? null
    : devices.find((device) => device.id === selectedMapDeviceId) ?? null;
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
      <View
        style={styles.mapCard}
        onLayout={({ nativeEvent }) => setMapSize(nativeEvent.layout)}
      >
        <EdgezOrganicMap
          ref={map}
          nodes={mapNodes}
          lines={[]}
          centerLatitude={profileCenter?.latitude ?? 59.3293}
          centerLongitude={profileCenter?.longitude ?? 18.0686}
          zoom={initialZoom}
          enableMapDownloads
          style={styles.map}
          onCameraChanged={(camera) => {
            mapZoom.current = camera.zoom;
            setMapCamera(camera);
            setSelectedMapDeviceId(null);
          }}
          onMapRegionAvailable={setRegion}
          onMapDownloadUpdate={(update) => {
            setRegion("");
            setDownload(update);
          }}
          onMapError={setMapError}
        />
        <View style={styles.mapMarkerHitLayer} pointerEvents="box-none">
          {locatedDevices.map((device) => {
            const point = deviceScreenPoint(device, mapCamera, mapSize);
            if (!point || point.x < -26 || point.x > mapSize.width + 26 || point.y < -26 || point.y > mapSize.height + 26) {
              return null;
            }
            return (
              <Pressable
                key={device.id}
                style={[styles.mapMarkerHitTarget, { left: point.x - 26, top: point.y - 26 }]}
                onPress={() => setSelectedMapDeviceId(device.id)}
                accessibilityRole="button"
                accessibilityLabel={`Show ${device.name}`}
              />
            );
          })}
        </View>

        {selectedMapDevice ? (
          <View style={styles.mapDeviceOverlay}>
            <View style={styles.mapDeviceOverlayHeader}>
              <View style={styles.mapDeviceOverlayBody}>
                <Text style={styles.mapDeviceOverlayName} numberOfLines={1}>{selectedMapDevice.name}</Text>
                <Text style={styles.mapDeviceOverlayLastSeen}>
                  Last seen: {selectedMapDevice.lastSeenAt
                    ? new Date(selectedMapDevice.lastSeenAt).toLocaleString()
                    : "Unknown"}
                </Text>
              </View>
              <Pressable
                style={styles.mapDeviceOverlayClose}
                onPress={() => setSelectedMapDeviceId(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close device summary"
              >
                <Ionicons name="close" size={22} color="#b8cdca" />
              </Pressable>
            </View>
            <Pressable
              style={styles.mapDeviceOverlayMessageButton}
              onPress={() => {
                setSelectedMapDeviceId(null);
                setConversationPeer(selectedMapDevice.meshMacAddress || selectedMapDevice.serial);
                setMessagesOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation with ${selectedMapDevice.name}`}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={17} color="white" />
              <Text style={styles.mapDeviceOverlayMessageText}>OPEN CONVERSATION</Text>
            </Pressable>
          </View>
        ) : null}
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
        <Pressable
          style={[
            styles.cloudMapStatus,
            cloudStatus === "online" && styles.cloudMapStatusOnline,
            cloudStatus === "login" && styles.cloudMapStatusLogin,
          ]}
          onPress={onCloudPress}
          disabled={cloudStatus !== "login"}
          accessibilityRole={cloudStatus === "login" ? "button" : "text"}
          accessibilityLabel={cloudStatus === "login" ? "Login to EdgeZ Cloud" : `Cloud ${cloudStatus}`}
        >
          <View style={[
            styles.cloudStatusDot,
            cloudStatus === "online" && styles.cloudStatusDotOnline,
            cloudStatus === "login" && styles.cloudStatusDotLogin,
          ]} />
          <Text style={[
            styles.cloudMapStatusText,
            cloudStatus === "online" && styles.cloudMapStatusTextOnline,
            cloudStatus === "login" && styles.cloudMapStatusTextLogin,
          ]}>
            {cloudStatus.toUpperCase()}
          </Text>
        </Pressable>
        <View style={styles.headerActions}>
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
