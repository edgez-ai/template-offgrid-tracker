import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { edgezNodeOpensConversation } from "@edgez/react-native-sdk";
import type { EdgezMeshNode } from "@edgez/react-native-sdk";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { StoredDevice } from "./profile-store";
import { getCloudSensorSettings, updateCloudSensorSettings } from "./cloud-auth";
import type { CloudDeviceUpdate } from "./cloud-auth";
import { beaconColorValues, beaconIconColors, beaconIconNames, beaconIconTypes } from "./beacon-options";
import type { BeaconIconColor, BeaconIconType } from "./beacon-options";
import { coordinatesFromLocation } from "./mesh-utils";
import { ProfileLocationPicker } from "./ProfileScreens";

const swipeActionWidth = 92;
const deviceMarkerStyles = ["gateway", "sensor", "tracker", "beacon", "relay", ...beaconIconTypes] as const;

export function DeviceDetail({
  device,
  liveNode,
  country,
  editable = false,
  allowMessaging = true,
  onClose,
  onMessage,
  onUpdate,
}: {
  device: StoredDevice | null;
  liveNode: EdgezMeshNode | null;
  country: string;
  editable?: boolean;
  allowMessaging?: boolean;
  onClose: () => void;
  onMessage: (device: StoredDevice) => void;
  onUpdate: (device: StoredDevice, update: CloudDeviceUpdate) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [markerType, setMarkerType] = useState("sensor");
  const [markerColor, setMarkerColor] = useState<BeaconIconColor>("blue");
  const [location, setLocation] = useState("");
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [samplingIntervalSeconds, setSamplingIntervalSeconds] = useState("15");
  const [blockSamplingCount, setBlockSamplingCount] = useState("0");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    setEditing(false);
    setName(device?.name ?? "");
    setMarkerType(device?.iconStyle || (device?.kind === "h7608" ? "gateway" : "sensor"));
    const color = device?.marker as BeaconIconColor | undefined;
    setMarkerColor(color && beaconIconColors.includes(color) ? color : "blue");
    setLocation(device?.latitude !== null && device?.latitude !== undefined && device?.longitude !== null && device?.longitude !== undefined
      ? `${device.latitude.toFixed(6)}, ${device.longitude.toFixed(6)}` : "");
    setLocationPickerOpen(false);
    setError("");
  }, [device]);

  useEffect(() => {
    let cancelled = false;
    setSamplingIntervalSeconds("15");
    setBlockSamplingCount("0");
    setSettingsStatus("");
    setSettingsError("");
    if (!device || !editable || device.kind === "h7608") return () => { cancelled = true; };
    setSettingsLoading(true);
    void getCloudSensorSettings(device.id).then((state) => {
      if (cancelled) return;
      if (state) {
        setSamplingIntervalSeconds(String(state.settings.samplingIntervalMs / 1000));
        setBlockSamplingCount(String(state.settings.blockSamplingCount));
        const updated = state.updatedAt ? ` · ${new Date(state.updatedAt).toLocaleString()}` : "";
        setSettingsStatus(`${state.status.toUpperCase()} · ${state.retryCount} RETRIES${updated}`);
      } else {
        setSettingsStatus("DEVICE DEFAULTS");
      }
    }).catch((caught) => {
      if (!cancelled) setSettingsError(caught instanceof Error ? caught.message : "Could not load sensor settings.");
    }).finally(() => {
      if (!cancelled) setSettingsLoading(false);
    });
    return () => { cancelled = true; };
  }, [device, editable]);

  if (!device) return null;
  const canMessage = liveNode
    ? edgezNodeOpensConversation(liveNode)
    : ["", "unspecified", "user", "device_type_user"].includes(device.deviceType.trim().toLowerCase());
  const save = async () => {
    const nextName = name.trim();
    if (!nextName || nextName.length > 128) {
      setError("Enter a device name up to 128 characters.");
      return;
    }
    const coordinates = location.trim() ? coordinatesFromLocation(location) : null;
    if (location.trim() && !coordinates) {
      setError("Enter a valid latitude and longitude.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onUpdate(device, {
        name: nextName,
        markerType,
        markerColor,
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
      });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the device.");
    } finally {
      setSaving(false);
    }
  };
  const saveSensorSettings = async () => {
    const seconds = Number(samplingIntervalSeconds);
    const samples = Number(blockSamplingCount);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600 ||
        !Number.isInteger(samples) || samples < 0 || samples > 32) {
      setSettingsError("Use a 1-3600 second interval and a block sampling count from 0 to 32.");
      return;
    }
    setSettingsSaving(true);
    setSettingsError("");
    try {
      await updateCloudSensorSettings(device.id, {
        samplingIntervalMs: seconds * 1000,
        blockSamplingCount: samples,
      });
      setSettingsStatus("QUEUED · APPLIES ON NEXT BEACON");
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : "Could not update sensor settings.");
    } finally {
      setSettingsSaving(false);
    }
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>OFFGRID DEVICE</Text><Text style={styles.title}>{device.name}</Text></View>
          <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8} accessibilityRole="button"><Text style={styles.close}>CLOSE</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.detailContent}>
          <View style={styles.hero}>
            <View style={styles.detailIcon}><Ionicons name={canMessage ? "person-outline" : "radio-outline"} size={28} color="#0a8c87" /></View>
            <Text style={styles.detailName}>{device.name}</Text>
            <Text style={styles.serial}>{device.meshMacAddress || device.serial}</Text>
          </View>
          <View style={styles.detailCard}>
            <DetailRow label="TYPE" value={device.deviceType || "Unspecified"} />
            <DetailRow label="HARDWARE" value={device.kind.toUpperCase()} />
            <DetailRow label="ROUTE" value={liveNode?.route || "Offline"} />
            <DetailRow label="STATE" value={liveNode ? (liveNode.sleeping ? "Sleeping" : "Awake") : "Not currently visible"} />
            <DetailRow label="LAST SEEN" value={device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : "Unknown"} />
            <DetailRow label="LOCATION" value={device.latitude !== null && device.longitude !== null ? `${device.latitude.toFixed(6)}, ${device.longitude.toFixed(6)}` : "Not shared"} />
          </View>
          {editable && device.kind !== "h7608" ? <View style={styles.settingsCard}>
            <View style={styles.settingsHeader}>
              <View><Text style={styles.settingsTitle}>SENSOR SETTINGS</Text><Text style={styles.settingsHint}>Delivered reliably after the next beacon</Text></View>
              {settingsLoading ? <ActivityIndicator size="small" color="#0a8c87" /> : null}
            </View>
            <Text style={styles.editLabel}>SAMPLING INTERVAL · SECONDS</Text>
            <TextInput style={styles.editInput} value={samplingIntervalSeconds} onChangeText={setSamplingIntervalSeconds} keyboardType="number-pad" maxLength={4} placeholder="15" placeholderTextColor="#829693" />
            <Text style={styles.editLabel}>BLOCK SAMPLING COUNT</Text>
            <TextInput style={styles.editInput} value={blockSamplingCount} onChangeText={setBlockSamplingCount} keyboardType="number-pad" maxLength={2} placeholder="0" placeholderTextColor="#829693" />
            <Text style={styles.settingsHint}>0 disables block sampling. A positive value caps samples collected before HaLow starts; upload chunks follow the actual encoded data size. Beacon and downlink ACK remain enabled.</Text>
            {settingsStatus ? <Text style={styles.settingsStatus}>{settingsStatus}</Text> : null}
            {settingsError ? <Text style={styles.editError}>{settingsError}</Text> : null}
            <Pressable style={[styles.primary, (settingsSaving || settingsLoading) && styles.buttonDisabled]} onPress={() => void saveSensorSettings()} disabled={settingsSaving || settingsLoading} accessibilityRole="button">
              {settingsSaving ? <ActivityIndicator size="small" color="white" /> : <Text style={styles.primaryText}>UPDATE SENSOR</Text>}
            </Pressable>
          </View> : null}
          {editable && !editing ? <Pressable style={styles.outline} onPress={() => setEditing(true)} accessibilityRole="button"><Text style={styles.outlineText}>EDIT DEVICE</Text></Pressable> : null}
          {editable && editing ? <View style={styles.editCard}>
            <Text style={styles.editLabel}>NAME</Text>
            <TextInput style={styles.editInput} value={name} onChangeText={setName} maxLength={128} placeholder="Device name" placeholderTextColor="#829693" />
            <Text style={styles.editLabel}>MARKER STYLE</Text>
            <View style={styles.markerStyles} accessibilityRole="radiogroup">
              {deviceMarkerStyles.map((style) => {
                const selected = markerType === style;
                const visual = beaconIconTypes.includes(style as BeaconIconType);
                return <Pressable key={style} style={[styles.markerStyle, selected && styles.markerStyleSelected]} onPress={() => setMarkerType(style)} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${style} marker`}>
                  {visual ? <MaterialCommunityIcons name={beaconIconNames[style as BeaconIconType]} size={19} color={selected ? "white" : "#0a8c87"} /> : <Ionicons name={style === "gateway" ? "git-network-outline" : style === "relay" ? "git-branch-outline" : "radio-outline"} size={19} color={selected ? "white" : "#0a8c87"} />}
                  <Text style={[styles.markerStyleText, selected && styles.markerStyleTextSelected]}>{style.toUpperCase()}</Text>
                </Pressable>;
              })}
            </View>
            <Text style={styles.editLabel}>MARKER COLOR</Text>
            <View style={styles.markerColors} accessibilityRole="radiogroup">
              {beaconIconColors.map((color) => <Pressable key={color} style={[styles.markerColor, markerColor === color && styles.markerColorSelected]} onPress={() => setMarkerColor(color)} accessibilityRole="radio" accessibilityState={{ selected: markerColor === color }} accessibilityLabel={`${color} marker color`}><View style={[styles.markerSwatch, { backgroundColor: beaconColorValues[color] }]} /></Pressable>)}
            </View>
            <Text style={styles.editLabel}>LOCATION</Text>
            <TextInput style={styles.editInput} value={location} onChangeText={setLocation} placeholder="Latitude, longitude" placeholderTextColor="#829693" autoCapitalize="none" autoCorrect={false} />
            <View style={styles.editActions}><Pressable style={styles.smallOutline} onPress={() => setLocationPickerOpen(true)}><Text style={styles.outlineText}>CHOOSE ON MAP</Text></Pressable><Pressable style={styles.smallOutline} onPress={() => setLocation("")}><Text style={styles.outlineText}>CLEAR</Text></Pressable></View>
            {error ? <Text style={styles.editError}>{error}</Text> : null}
            <View style={styles.editActions}><Pressable style={styles.smallOutline} onPress={() => setEditing(false)} disabled={saving}><Text style={styles.outlineText}>CANCEL</Text></Pressable><Pressable style={styles.smallPrimary} onPress={() => void save()} disabled={saving}>{saving ? <ActivityIndicator size="small" color="white" /> : <Text style={styles.primaryText}>SAVE</Text>}</Pressable></View>
          </View> : null}
          {allowMessaging && canMessage ? <Pressable style={styles.primary} onPress={() => onMessage(device)} accessibilityRole="button"><Text style={styles.primaryText}>START NEW CONVERSATION</Text></Pressable> : null}
        </ScrollView>
        <Modal visible={locationPickerOpen} animationType="slide" onRequestClose={() => setLocationPickerOpen(false)}>
          <ProfileLocationPicker subject="device" location={location} country={country} onCancel={() => setLocationPickerOpen(false)} onSelect={(value) => { setLocation(value); setLocationPickerOpen(false); }} />
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.detailRow}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>;
}

export function SwipeableDeviceRow({
  device,
  icon = device.kind === "h7608" ? "git-network-outline" : "radio-outline",
  subtitle,
  meta,
  badge,
  onOpen,
  onRemove,
}: {
  device: StoredDevice;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  subtitle?: string;
  meta?: string;
  badge?: string;
  onOpen: (device: StoredDevice) => void;
  onRemove: (device: StoredDevice) => void;
}) {
  return <SwipeableListRow
    accessibilityName={device.name}
    icon={icon}
    name={device.name}
    subtitle={subtitle ?? (device.meshMacAddress || device.serial)}
    meta={meta ?? (device.latitude !== null && device.longitude !== null ? `${device.latitude.toFixed(5)}, ${device.longitude.toFixed(5)}` : "Location not shared")}
    badge={badge}
    onOpen={() => onOpen(device)}
    onRemove={() => onRemove(device)}
  />;
}

export function SwipeableListRow({
  accessibilityName,
  icon,
  name,
  subtitle,
  meta,
  badge,
  onOpen,
  onRemove,
}: {
  accessibilityName: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  name: string;
  subtitle: string;
  meta: string;
  badge?: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const settle = (showActions: boolean) => {
    open.current = showActions;
    Animated.spring(translateX, { toValue: showActions ? -swipeActionWidth : 0, useNativeDriver: true, bounciness: 0 }).start();
  };
  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      const start = open.current ? -swipeActionWidth : 0;
      translateX.setValue(Math.max(-swipeActionWidth, Math.min(0, start + gesture.dx)));
    },
    onPanResponderRelease: (_, gesture) => settle(open.current ? gesture.dx < swipeActionWidth / 3 : gesture.dx < -swipeActionWidth / 3),
    onPanResponderTerminate: () => settle(open.current),
  })).current;

  return (
    <View style={styles.swipeContainer}>
      <Pressable style={styles.removeAction} onPress={onRemove} accessibilityRole="button" accessibilityLabel={`Remove ${accessibilityName}`}>
        <Ionicons name="trash-outline" size={21} color="white" /><Text style={styles.removeText}>REMOVE</Text>
      </Pressable>
      <Animated.View style={[styles.card, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <Pressable style={styles.open} onPress={onOpen} accessibilityRole="button">
          <View style={styles.nodeIcon}><Ionicons name={icon} size={21} color="#0a8c87" /></View>
          <View style={styles.body}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.serial} numberOfLines={1}>{subtitle}</Text>
            <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
          </View>
          <View style={styles.rowEnd}>
            {badge ? <Text style={styles.badge}>{badge}</Text> : null}
            <Ionicons name="chevron-forward" size={17} color="#718783" />
          </View>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f7faf9" },
  header: { minHeight: 84, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  eyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  title: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  closeButton: { minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" },
  close: { color: "#59716f", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 },
  detailContent: { padding: 22, paddingBottom: 42, gap: 14 },
  hero: { alignItems: "center", paddingVertical: 18, gap: 5 },
  detailIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#e9f7f5", alignItems: "center", justifyContent: "center", marginBottom: 5 },
  detailName: { color: "#0a3037", fontSize: 24, fontWeight: "900" },
  detailCard: { borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", paddingHorizontal: 15 },
  detailRow: { minHeight: 55, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#dce6e5" },
  detailLabel: { color: "#718783", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  detailValue: { flex: 1, color: "#0a3037", fontSize: 12, fontWeight: "700", textAlign: "right" },
  primary: { minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  primaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  outline: { minHeight: 48, borderWidth: 1, borderColor: "#0a8c87", borderRadius: 12, alignItems: "center", justifyContent: "center" },
  outlineText: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  editCard: { padding: 15, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", gap: 9 },
  editLabel: { color: "#59716f", fontSize: 9, fontWeight: "900", letterSpacing: 0.8, marginTop: 4 },
  editInput: { minHeight: 50, paddingHorizontal: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 11, color: "#0a3037", backgroundColor: "#f7faf9", fontSize: 13 },
  markerStyles: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  markerStyle: { minWidth: "30%", minHeight: 48, paddingHorizontal: 9, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 11, alignItems: "center", justifyContent: "center", gap: 3, backgroundColor: "#f7faf9" },
  markerStyleSelected: { borderColor: "#0a8c87", backgroundColor: "#0a8c87" },
  markerStyleText: { color: "#385753", fontSize: 7, fontWeight: "900", letterSpacing: 0.4 },
  markerStyleTextSelected: { color: "white" },
  markerColors: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  markerColor: { width: 40, height: 40, borderWidth: 2, borderColor: "transparent", borderRadius: 20, alignItems: "center", justifyContent: "center" },
  markerColorSelected: { borderColor: "#0a8c87", backgroundColor: "#e9f7f5" },
  markerSwatch: { width: 25, height: 25, borderRadius: 13 },
  editActions: { flexDirection: "row", gap: 8 },
  smallOutline: { flex: 1, minHeight: 45, borderWidth: 1, borderColor: "#0a8c87", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  smallPrimary: { flex: 1, minHeight: 45, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  editError: { color: "#b9472f", fontSize: 11, lineHeight: 16 },
  settingsCard: { padding: 15, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", gap: 9 },
  settingsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  settingsTitle: { color: "#0a3037", fontSize: 13, fontWeight: "900", letterSpacing: 0.7 },
  settingsHint: { color: "#718783", fontSize: 9, lineHeight: 14, marginTop: 2 },
  settingsStatus: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.5 },
  buttonDisabled: { opacity: 0.55 },
  swipeContainer: { borderRadius: 14, overflow: "hidden", backgroundColor: "#b9472f" },
  removeAction: { position: "absolute", top: 0, right: 0, bottom: 0, width: swipeActionWidth, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: "#b9472f" },
  removeText: { color: "white", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  card: { minHeight: 86, padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 14, backgroundColor: "white", flexDirection: "row", alignItems: "center", gap: 12 },
  open: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  nodeIcon: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: "#e9f7f5" },
  body: { flex: 1, gap: 3 },
  name: { color: "#0a3037", fontSize: 15, fontWeight: "900" },
  serial: { color: "#385753", fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  meta: { color: "#718783", fontSize: 10, lineHeight: 15 },
  kind: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  rowEnd: { alignItems: "flex-end", gap: 7 },
  badge: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
});
