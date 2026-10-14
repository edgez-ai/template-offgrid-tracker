import Ionicons from "@expo/vector-icons/Ionicons";
import { edgezNodeOpensConversation } from "@edgez/react-native-sdk";
import type { EdgezMeshNode } from "@edgez/react-native-sdk";
import React, { useRef } from "react";
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { StoredDevice } from "./profile-store";

const swipeActionWidth = 92;

export function DeviceDetail({
  device,
  liveNode,
  onClose,
  onMessage,
}: {
  device: StoredDevice | null;
  liveNode: EdgezMeshNode | null;
  onClose: () => void;
  onMessage: (device: StoredDevice) => void;
}) {
  if (!device) return null;
  const canMessage = liveNode
    ? edgezNodeOpensConversation(liveNode)
    : ["", "unspecified", "user", "device_type_user"].includes(device.deviceType.trim().toLowerCase());
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
          {canMessage ? <Pressable style={styles.primary} onPress={() => onMessage(device)} accessibilityRole="button"><Text style={styles.primaryText}>START NEW CONVERSATION</Text></Pressable> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.detailRow}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.detailValue}>{value}</Text></View>;
}

export function SwipeableDeviceRow({
  device,
  onOpen,
  onRemove,
}: {
  device: StoredDevice;
  onOpen: (device: StoredDevice) => void;
  onRemove: (device: StoredDevice) => void;
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
      <Pressable style={styles.removeAction} onPress={() => onRemove(device)} accessibilityRole="button" accessibilityLabel={`Remove ${device.name}`}>
        <Ionicons name="trash-outline" size={21} color="white" /><Text style={styles.removeText}>REMOVE</Text>
      </Pressable>
      <Animated.View style={[styles.card, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <Pressable style={styles.open} onPress={() => onOpen(device)} accessibilityRole="button">
          <View style={styles.nodeIcon}><Ionicons name={device.kind === "h7608" ? "git-network-outline" : "radio-outline"} size={21} color="#0a8c87" /></View>
          <View style={styles.body}>
            <Text style={styles.name}>{device.name}</Text>
            <Text style={styles.serial}>{device.meshMacAddress || device.serial}</Text>
            <Text style={styles.meta}>{device.latitude !== null && device.longitude !== null ? `${device.latitude.toFixed(5)}, ${device.longitude.toFixed(5)}` : "Location not shared"}</Text>
          </View>
          <Text style={styles.kind}>{device.kind.toUpperCase()}</Text>
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
});
