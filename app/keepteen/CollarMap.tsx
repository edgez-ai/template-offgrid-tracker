import Ionicons from "@expo/vector-icons/Ionicons";
import { EdgezOrganicMap } from "@edgez/react-native-sdk";
import type { EdgezMapCamera, EdgezMapDownloadUpdate, EdgezMapIcon, EdgezMapLine, EdgezOrganicMapRef } from "@edgez/react-native-sdk";
import * as Location from "expo-location";
import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { compatibleCurrentLocation } from "../location-utils";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

export type CollarMapMarker = { id: string; label: string; latitude: number; longitude: number; marker?: string; icon?: EdgezMapIcon };
export type CollarMapHandle = { camera: () => EdgezMapCamera; focus: (latitude: number, longitude: number, zoom?: number) => void };

const MAX_MERCATOR_LATITUDE = 85.05112878;

function mercatorPoint(latitude: number, longitude: number, zoom: number) {
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
  const radians = clamped * Math.PI / 180;
  const worldSize = 256 * 2 ** zoom;
  return {
    x: (longitude + 180) / 360 * worldSize,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * worldSize,
    worldSize,
  };
}

function screenPoint(marker: CollarMapMarker, camera: EdgezMapCamera, size: { width: number; height: number }) {
  if (size.width <= 0 || size.height <= 0) return null;
  const center = mercatorPoint(camera.latitude, camera.longitude, camera.zoom);
  const point = mercatorPoint(marker.latitude, marker.longitude, camera.zoom);
  let deltaX = point.x - center.x;
  if (deltaX > center.worldSize / 2) deltaX -= center.worldSize;
  if (deltaX < -center.worldSize / 2) deltaX += center.worldSize;
  return { x: size.width / 2 + deltaX, y: size.height / 2 + point.y - center.y };
}

/**
 * Offline Organic Maps view from the SDK with marker hit targets, fence
 * outlines and the existing region-download prompt. The initial camera is the
 * first located node, then the profile's fixed location, and only then the
 * historical Stockholm default (R23: the default must not override real data).
 */
export const CollarMap = forwardRef<CollarMapHandle, {
  markers: CollarMapMarker[];
  lines?: EdgezMapLine[];
  fallbackCenter: { latitude: number; longitude: number } | null;
  onSelect?: (id: string) => void;
  crosshair?: boolean;
  height?: number;
}>(function CollarMap({ markers, lines = [], fallbackCenter, onSelect, crosshair, height }, ref) {
  const { colors, mode } = useTheme();
  const { t } = useI18n();
  const map = useRef<EdgezOrganicMapRef>(null);
  const start = markers[0] ?? fallbackCenter ?? { latitude: 59.3293, longitude: 18.0686 };
  const startZoom = markers.length ? 14 : fallbackCenter ? 12 : 9;
  const [camera, setCamera] = useState<EdgezMapCamera>({ latitude: start.latitude, longitude: start.longitude, zoom: startZoom });
  const cameraRef = useRef(camera);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [region, setRegion] = useState("");
  const [download, setDownload] = useState<EdgezMapDownloadUpdate | null>(null);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const [you, setYou] = useState<{ latitude: number; longitude: number } | null>(null);

  useImperativeHandle(ref, () => ({
    camera: () => cameraRef.current,
    focus: (latitude, longitude, zoom) => map.current?.setCamera({ latitude, longitude, zoom: zoom ?? Math.max(cameraRef.current.zoom, 15) }),
  }), []);

  const locate = async () => {
    if (locating) return;
    setLocating(true);
    setError("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error(t("mapLocationPermission"));
      if (!await Location.hasServicesEnabledAsync()) throw new Error(t("mapLocationOff"));
      const coordinates = await compatibleCurrentLocation();
      setYou(coordinates);
      map.current?.setCamera({ ...coordinates, zoom: Math.max(cameraRef.current.zoom, 15) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("mapLocationFailed"));
    } finally {
      setLocating(false);
    }
  };

  const nodes = [
    ...markers.map((marker) => ({ ...marker, marker: marker.marker || "default", icon: marker.icon ?? "tracker" as const })),
    ...(you ? [{ id: "current-location", label: t("mapYou"), icon: "gps" as const, ...you }] : []),
  ];

  return (
    <View style={[styles.wrap, height ? { height } : styles.fill]} onLayout={({ nativeEvent }) => setSize(nativeEvent.layout)}>
      <EdgezOrganicMap
        ref={map}
        nodes={nodes}
        lines={lines}
        centerLatitude={start.latitude}
        centerLongitude={start.longitude}
        zoom={startZoom}
        enableMapDownloads
        style={StyleSheet.absoluteFill}
        onMapReady={() => map.current?.setMapTheme(mode === "dark" ? "night" : "day")}
        onCameraChanged={(next) => { cameraRef.current = next; setCamera(next); }}
        onMapRegionAvailable={setRegion}
        onMapDownloadUpdate={(update) => { setRegion(""); setDownload(update); }}
        onMapError={setError}
      />
      {onSelect ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {markers.map((marker) => {
            const point = screenPoint(marker, camera, size);
            if (!point || point.x < -26 || point.y < -26 || point.x > size.width + 26 || point.y > size.height + 26) return null;
            return (
              <Pressable
                key={marker.id}
                style={[styles.hit, { left: point.x - 24, top: point.y - 24 }]}
                onPress={() => onSelect(marker.id)}
                accessibilityRole="button"
                accessibilityLabel={marker.label}
              />
            );
          })}
        </View>
      ) : null}
      {crosshair ? (
        <View style={styles.crosshair} pointerEvents="none">
          <Ionicons name="add" size={34} color={colors.accent} />
        </View>
      ) : null}

      {region ? (
        <View style={[styles.prompt, { backgroundColor: colors.card }]}>
          <Text style={[styles.promptTitle, { color: colors.text }]}>{t("mapSaveRegion", { region })}</Text>
          <Text style={[styles.promptText, { color: colors.secondary }]}>{t("mapSaveRegionHint")}</Text>
          <View style={styles.promptActions}>
            <Pressable style={[styles.promptButton, { backgroundColor: colors.primary }]} onPress={() => { map.current?.downloadRegion(region); setRegion(""); }} accessibilityRole="button">
              <Text style={[styles.promptButtonText, { color: colors.onPrimary }]}>{t("mapDownload")}</Text>
            </Pressable>
            <Pressable style={styles.promptButton} onPress={() => { map.current?.dismissDownloadRegion(region); setRegion(""); }} accessibilityRole="button">
              <Text style={[styles.promptButtonText, { color: colors.text }]}>{t("notNow")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {download && !download.finished ? (
        <View style={[styles.toast, { backgroundColor: colors.card }]}>
          <Text style={[styles.toastText, { color: colors.text }]}>
            {download.status}{download.progress === undefined ? "" : ` · ${Math.round(download.progress)}%`}
          </Text>
        </View>
      ) : null}
      {error ? (
        <Pressable style={[styles.toast, { backgroundColor: colors.card }]} onPress={() => setError("")}>
          <Text style={[styles.toastText, { color: colors.danger }]}>{error}</Text>
        </Pressable>
      ) : null}

      <View style={styles.controls}>
        <Pressable style={[styles.control, { backgroundColor: colors.card }]} onPress={() => void locate()} accessibilityRole="button" accessibilityLabel={t("mapShowMe")}>
          {locating ? <ActivityIndicator color={colors.text} /> : <Ionicons name="locate-outline" size={22} color={colors.text} />}
        </Pressable>
      </View>
      <Text style={[styles.attribution, { color: colors.secondary }]}>© OpenStreetMap contributors</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { overflow: "hidden", borderRadius: 16 },
  fill: { flex: 1 },
  hit: { position: "absolute", width: 48, height: 48, borderRadius: 24 },
  crosshair: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  prompt: { position: "absolute", left: 12, right: 12, bottom: 12, borderRadius: 16, padding: 14, gap: 6 },
  promptTitle: { fontSize: 15, fontWeight: "600" },
  promptText: { fontSize: 13 },
  promptActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  promptButton: { minHeight: 40, borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
  promptButtonText: { fontSize: 14, fontWeight: "600" },
  toast: { position: "absolute", top: 12, left: 12, right: 64, borderRadius: 12, padding: 10 },
  toastText: { fontSize: 13 },
  controls: { position: "absolute", top: 12, right: 12, gap: 8 },
  control: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  attribution: { position: "absolute", left: 10, bottom: 6, fontSize: 10 },
});
