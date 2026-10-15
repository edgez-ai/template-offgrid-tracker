import Ionicons from "@expo/vector-icons/Ionicons";
import { Interface, Mime, Operation, edgezNodeDisplayName, edgezNodeId, edgezNodeOpensConversation, edgezPublicChannelNode, edgezPublicChannelPorts, encodeNetworkPacket } from "@edgez/react-native-sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { EdgezMeshSession, EdgezMeshState, EdgezSensorData } from "@edgez/react-native-sdk";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SwipeableDeviceRow } from "./DeviceComponents";
import { localMessageId, nodeNumFromSerial, normalizedDeviceSerial } from "./mesh-utils";
import { displayedMessageStatus, isPeerOnline, peerLastSeenMs } from "./message-delivery";
import { saveProfileMessage } from "./profile-store";
import type { StoredDevice, StoredMessage } from "./profile-store";

type InboxTab = "channels" | "people" | "sensors";
type ConversationPeer = { id: string; name: string; serial: string; nodeNum: bigint | null; publicChannel: boolean; device: StoredDevice | null };

const inboxTabStorageKey = "offgrid-tracker:last-inbox-tab:v1";
const personTypes = new Set(["", "unspecified", "user", "device_type_user", "person", "hiker", "explorer"]);
const sensorFields: ReadonlyArray<{ key: keyof EdgezSensorData; label: string; unit: string; decimals: number }> = [
  { key: "temperature", label: "Temperature", unit: "°C", decimals: 1 },
  { key: "humidity", label: "Humidity", unit: "%", decimals: 1 },
  { key: "pressure", label: "Pressure", unit: " hPa", decimals: 1 },
  { key: "altitude", label: "Altitude", unit: " m", decimals: 1 },
  { key: "vibrationAverage", label: "Vibration", unit: "", decimals: 2 },
  { key: "accelX", label: "Accel X", unit: "", decimals: 2 },
  { key: "accelY", label: "Accel Y", unit: "", decimals: 2 },
  { key: "accelZ", label: "Accel Z", unit: "", decimals: 2 },
  { key: "gyroX", label: "Gyro X", unit: "", decimals: 2 },
  { key: "gyroY", label: "Gyro Y", unit: "", decimals: 2 },
  { key: "gyroZ", label: "Gyro Z", unit: "", decimals: 2 },
  { key: "latitude", label: "Latitude", unit: "°", decimals: 5 },
  { key: "longitude", label: "Longitude", unit: "°", decimals: 5 },
];

export function MeshMessages({ visible, profileId, session, meshState, devices, messages, initialPeerSerial, onMessagesChanged, onResendMessage, onShowDevice, onRemoveDevice, onClose }: {
  visible: boolean;
  profileId: string;
  session: EdgezMeshSession | null;
  meshState: EdgezMeshState | null;
  devices: StoredDevice[];
  messages: StoredMessage[];
  initialPeerSerial: string | null;
  onMessagesChanged: () => Promise<void>;
  onResendMessage: (message: StoredMessage) => Promise<void>;
  onShowDevice: (device: StoredDevice) => void;
  onRemoveDevice: (device: StoredDevice) => void;
  onClose: () => void;
}) {
  const channels: ConversationPeer[] = edgezPublicChannelPorts
    .map((nodeNum, index) => meshState?.nodes.get(nodeNum) ?? edgezPublicChannelNode(index + 1))
    .filter((node) => node.enabled !== false)
    .map((node) => ({ id: `channel-${node.nodeNum}`, name: edgezNodeDisplayName(node), serial: edgezNodeId(node.nodeNum).toUpperCase(), nodeNum: node.nodeNum, publicChannel: true, device: null }));
  const people = devices.filter((device) => {
    const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
    const liveNode = nodeNum === null ? undefined : meshState?.nodes.get(nodeNum);
    return liveNode ? edgezNodeOpensConversation(liveNode) : personTypes.has(device.deviceType.trim().toLowerCase());
  });
  const peopleIds = new Set(people.map((device) => device.id));
  const sensors = devices.filter((device) => !peopleIds.has(device.id));
  const peoplePeers: ConversationPeer[] = people.map((device) => ({ id: device.id, name: device.name, serial: device.meshMacAddress || device.serial, nodeNum: nodeNumFromSerial(device.meshMacAddress || device.serial), publicChannel: false, device }));
  const peers = [...channels, ...peoplePeers];
  const [tab, setTab] = useState<InboxTab>("channels");
  const [peerSerial, setPeerSerial] = useState<string | null>(null);
  const [sensorId, setSensorId] = useState<string | null>(null);
  const [channelInfo, setChannelInfo] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [resendingUuid, setResendingUuid] = useState<string | null>(null);
  const [error, setError] = useState("");
  const selectedPeer = peerSerial ? peers.find((peer) => sameSerial(peer.serial, peerSerial)) ?? null : null;
  const selectedSensor = sensorId ? sensors.find((device) => device.id === sensorId) ?? null : null;
  const selectedNode = selectedPeer?.nodeNum == null ? null : meshState?.nodes.get(selectedPeer.nodeNum) ?? null;
  const conversation = selectedPeer ? messages.filter((item) => !item.retryOfUuid && sameSerial(item.peerSerial, selectedPeer.serial)).sort((a, b) => a.timestampMs - b.timestampMs) : [];
  const sensorNodeNum = selectedSensor ? nodeNumFromSerial(selectedSensor.meshMacAddress || selectedSensor.serial) : null;
  const samples = sensorNodeNum === null ? [] : meshState?.sensorSamples.get(sensorNodeNum) ?? [];

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(inboxTabStorageKey).then((storedTab) => {
      if (mounted && (storedTab === "channels" || storedTab === "people" || storedTab === "sensors")) setTab(storedTab);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!visible) return;
    setChannelInfo(false);
    setError("");
    if (!initialPeerSerial) return;
    const sensor = sensors.find((device) => sameSerial(device.meshMacAddress || device.serial, initialPeerSerial));
    if (sensor) {
      setTab("sensors"); setSensorId(sensor.id); setPeerSerial(null);
      void AsyncStorage.setItem(inboxTabStorageKey, "sensors").catch(() => undefined);
      return;
    }
    const peer = peers.find((item) => sameSerial(item.serial, initialPeerSerial));
    if (peer) {
      const peerTab = peer.publicChannel ? "channels" : "people";
      setTab(peerTab); setPeerSerial(peer.serial); setSensorId(null);
      void AsyncStorage.setItem(inboxTabStorageKey, peerTab).catch(() => undefined);
    }
  }, [initialPeerSerial, visible]);

  const latestBySerial = useMemo(() => {
    const latest = new Map<string, StoredMessage>();
    messages.filter((item) => !item.retryOfUuid).forEach((item) => {
      const key = normalizedDeviceSerial(item.peerSerial);
      if (!latest.has(key) || (latest.get(key)?.timestampMs ?? 0) < item.timestampMs) latest.set(key, item);
    });
    return latest;
  }, [messages]);

  const selectTab = (next: InboxTab) => {
    setTab(next); setPeerSerial(null); setSensorId(null); setChannelInfo(false); setError("");
    void AsyncStorage.setItem(inboxTabStorageKey, next).catch(() => undefined);
  };
  const closeDetail = () => { setPeerSerial(null); setSensorId(null); setChannelInfo(false); setError(""); };

  const send = async () => {
    const text = message.trim();
    if (!session || !selectedNode || !selectedPeer || !text || sending) return;
    setSending(true); setError("");
    try {
      if (selectedPeer.publicChannel) {
        const from = meshState?.status?.macAddress;
        if (!from) throw new Error("Local HaLow address is not ready.");
        const id = localMessageId();
        const packet = encodeNetworkPacket({ from, to: selectedNode.nodeNum, operation: Operation.request, interface: Interface.halow, msg: { messageIdHigh: id.high, messageIdLow: id.low, sequence: 1, mime: Mime.text, payload: new TextEncoder().encode(text) } });
        await session.sdk.transport.invoke("sendPacket", { label: `Public channel message to ${selectedPeer.name}`, packet: Array.from(packet), waitForDrainMs: 3000 });
        await saveProfileMessage(profileId, selectedPeer.serial, { nodeNum: selectedNode.nodeNum, text, mine: true, timestampMs: Date.now(), messageUuid: id.uuid, status: "Sent", voiceBytes: new Uint8Array(), voiceCodec: 0, durationMs: 0 });
        await onMessagesChanged();
      } else {
        await session.sendTextMessage(selectedNode.nodeNum, text);
      }
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the mesh message.");
    } finally { setSending(false); }
  };

  const resend = async (item: StoredMessage) => {
    if (resendingUuid) return;
    setResendingUuid(item.messageUuid); setError("");
    try {
      await onResendMessage(item);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resend the mesh message.");
    } finally {
      setResendingUuid(null);
    }
  };

  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <View><Text style={styles.eyebrow}>OFFGRID</Text><Text style={styles.title}>{selectedPeer?.name ?? selectedSensor?.name ?? "Messages"}</Text></View>
        <View style={styles.headerActions}>
          {selectedPeer || selectedSensor ? <Pressable style={styles.iconButton} onPress={() => {
            const device = selectedPeer?.device ?? selectedSensor;
            if (device) onShowDevice(device); else setChannelInfo((value) => !value);
          }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Show details"><Ionicons name="information-circle-outline" size={25} color="#0a8c87" /></Pressable> : null}
          <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8} accessibilityRole="button"><Text style={styles.close}>CLOSE</Text></Pressable>
        </View>
      </View>

      {!selectedPeer && !selectedSensor ? <View style={styles.tabs}>{(["channels", "people", "sensors"] as const).map((item) => <Pressable key={item} style={[styles.tab, tab === item && styles.activeTab]} onPress={() => selectTab(item)} accessibilityRole="tab" accessibilityState={{ selected: tab === item }}><Text style={[styles.tabText, tab === item && styles.activeTabText]}>{item.toUpperCase()}</Text></Pressable>)}</View> : null}

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!selectedPeer && !selectedSensor && tab === "channels" ? <View style={styles.list}>{channels.map((peer) => <ChannelRow key={peer.id} peer={peer} latest={latestBySerial.get(normalizedDeviceSerial(peer.serial))} onOpen={() => setPeerSerial(peer.serial)} />)}</View> : null}

        {!selectedPeer && !selectedSensor && tab === "people" ? people.length ? <View style={styles.list}>{people.map((device) => {
          const serial = device.meshMacAddress || device.serial;
          const latest = latestBySerial.get(normalizedDeviceSerial(serial));
          const lastSeen = peerLastSeenMs(serial, devices, meshState);
          return <SwipeableDeviceRow key={device.id} device={device} icon="person-outline" subtitle={latest?.text || "Start a mesh conversation"} meta={lastSeenLabel(lastSeen, isPeerOnline(serial, devices, meshState))} badge={latest?.mine ? displayedMessageStatus(latest).toUpperCase() : undefined} onOpen={() => setPeerSerial(serial)} onRemove={onRemoveDevice} />;
        })}</View> : <EmptyState icon="people-outline" title="No people discovered" text="People appear here after their beacon reaches this profile. They remain available before the first message." /> : null}

        {!selectedPeer && !selectedSensor && tab === "sensors" ? sensors.length ? <View style={styles.list}>{sensors.map((device) => {
          const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
          const deviceSamples = nodeNum === null ? [] : meshState?.sensorSamples.get(nodeNum) ?? [];
          const latest = deviceSamples[deviceSamples.length - 1];
          const serial = device.meshMacAddress || device.serial;
          const lastSeen = peerLastSeenMs(serial, devices, meshState);
          return <SwipeableDeviceRow key={device.id} device={device} icon="pulse-outline" subtitle={latest ? sensorSummary(latest.data) : "No sensor data yet"} meta={lastSeenLabel(lastSeen, isPeerOnline(serial, devices, meshState))} badge={deviceSamples.length ? `${deviceSamples.length} SAMPLE${deviceSamples.length === 1 ? "" : "S"}` : undefined} onOpen={() => setSensorId(device.id)} onRemove={onRemoveDevice} />;
        })}</View> : <EmptyState icon="pulse-outline" title="No sensors discovered" text="Sensors and other mesh devices appear here after their beacon reaches this profile." /> : null}

        {selectedPeer ? <>
          <BackButton label={tab} onPress={closeDetail} />
          {channelInfo ? <View style={styles.infoCard}><View style={styles.infoIcon}><Ionicons name="people-outline" size={28} color="#0a8c87" /></View><Text style={styles.infoTitle}>{selectedPeer.name}</Text><Text style={styles.muted}>Public clear-text mesh channel</Text><InfoRow label="ADDRESS" value={selectedPeer.serial} /><InfoRow label="MESSAGES" value={String(conversation.length)} /></View> : <>
            <View style={styles.conversation}>{conversation.length ? conversation.map((item) => {
              const status = displayedMessageStatus(item);
              const failed = item.mine && status === "Failed";
              return <View key={item.messageUuid} style={[styles.bubble, item.mine ? styles.mine : styles.peer]}><Text style={styles.messageText}>{item.text}</Text><View style={styles.messageFooter}><Text style={styles.messageStatus}>{item.mine ? status : selectedPeer.name} · {timestamp(item.timestampMs)}</Text>{failed ? <Pressable style={styles.resendButton} disabled={resendingUuid === item.messageUuid} onPress={() => void resend(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Resend message">{resendingUuid === item.messageUuid ? <ActivityIndicator size="small" color="#0a8c87" /> : <><Ionicons name="refresh" size={13} color="#0a8c87" /><Text style={styles.resendText}>RESEND</Text></>}</Pressable> : null}</View></View>;
            }) : <Text style={styles.muted}>No messages yet. Send the first message below.</Text>}</View>
            <TextInput style={styles.input} value={message} onChangeText={setMessage} placeholder="Message over HaLow mesh" placeholderTextColor="#718783" multiline />
            <Pressable style={[styles.send, (!message.trim() || sending || !meshState?.bleReady || !selectedNode) && styles.disabled]} disabled={!message.trim() || sending || !meshState?.bleReady || !selectedNode} onPress={() => void send()} accessibilityRole="button">{sending ? <ActivityIndicator color="white" /> : <Text style={styles.sendText}>SEND OVER MESH</Text>}</Pressable>
            {!selectedNode ? <Text style={styles.error}>The cached device identity is incomplete. Wait for one beacon to refresh it.</Text> : null}
            {selectedNode && !meshState?.bleReady ? <Text style={styles.error}>BLE control channel is not ready.</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>}
        </> : null}

        {selectedSensor ? <>
          <BackButton label="sensors" onPress={closeDetail} />
          <View style={styles.sensorHero}><Ionicons name="pulse-outline" size={28} color="#0a8c87" /><View style={styles.sensorHeroText}><Text style={styles.sensorTitle}>Data statistics</Text><Text style={styles.muted}>{samples.length} received sample{samples.length === 1 ? "" : "s"}</Text></View></View>
          {!samples.length ? <EmptyState icon="analytics-outline" title="No data received yet" text="This device is saved in the profile. Statistics appear when a sensor beacon arrives." /> : <View style={styles.statsGrid}>
            {sensorFields.map((field) => {
              const values = samples.map((sample) => sample.data[field.key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
              if (!values.length) return null;
              const latest = values[values.length - 1]; const min = Math.min(...values); const max = Math.max(...values); const average = values.reduce((sum, value) => sum + value, 0) / values.length;
              const format = (value: number) => `${value.toFixed(field.decimals)}${field.unit}`;
              return <View key={field.key} style={styles.statCard}><Text style={styles.statLabel}>{field.label.toUpperCase()}</Text><Text style={styles.statValue}>{format(latest)}</Text><Text style={styles.statRange}>AVG {format(average)} · MIN {format(min)} · MAX {format(max)}</Text></View>;
            })}
            <Text style={styles.sampleTime}>Latest sample · {timestamp(samples[samples.length - 1].timestampMs)}</Text>
          </View>}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

function ChannelRow({ peer, latest, onOpen }: { peer: ConversationPeer; latest?: StoredMessage; onOpen: () => void }) {
  return <Pressable style={styles.row} onPress={onOpen} accessibilityRole="button"><View style={styles.rowIcon}><Ionicons name="people-outline" size={20} color="#0a8c87" /></View><View style={styles.rowBody}><Text style={styles.peerName}>{peer.name}</Text><Text style={styles.preview} numberOfLines={1}>{latest?.text || "Send to everyone on this channel"}</Text></View><View style={styles.rowMeta}><Text style={styles.time}>PUBLIC CHANNEL</Text><Ionicons name="chevron-forward" size={17} color="#718783" /></View></Pressable>;
}
function BackButton({ label, onPress }: { label: string; onPress: () => void }) { return <Pressable style={styles.back} onPress={onPress} accessibilityRole="button"><Ionicons name="chevron-back" size={18} color="#0a8c87" /><Text style={styles.actionText}>{label.toUpperCase()}</Text></Pressable>; }
function EmptyState({ icon, title, text }: { icon: React.ComponentProps<typeof Ionicons>["name"]; title: string; text: string }) { return <View style={styles.empty}><Ionicons name={icon} size={25} color="#0a8c87" /><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.muted}>{text}</Text></View>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <View style={styles.infoRow}><Text style={styles.infoLabel}>{label}</Text><Text style={styles.infoValue}>{value}</Text></View>; }
function sameSerial(a: string, b: string) { return normalizedDeviceSerial(a) === normalizedDeviceSerial(b); }
function timestamp(value: number) { return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function lastSeenLabel(value: number, online: boolean) { return value > 0 ? `${online ? "ONLINE · " : ""}LAST SEEN ${timestamp(value)}` : "LAST SEEN UNKNOWN"; }
function sensorSummary(data: EdgezSensorData) {
  if (typeof data.temperature === "number") return `${data.temperature.toFixed(1)}°C${typeof data.humidity === "number" ? ` · ${data.humidity.toFixed(0)}% RH` : ""}`;
  if (typeof data.vibrationAverage === "number") return `Vibration ${data.vibrationAverage.toFixed(2)}`;
  if (typeof data.latitude === "number" && typeof data.longitude === "number") return `${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`;
  return "Sensor sample received";
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f7faf9" },
  header: { minHeight: 84, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  eyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 }, title: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, closeButton: { minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" }, close: { color: "#59716f", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 },
  tabs: { marginHorizontal: 22, marginTop: 16, padding: 4, borderRadius: 14, backgroundColor: "#e5efed", flexDirection: "row" }, tab: { flex: 1, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center" }, activeTab: { backgroundColor: "white", shadowColor: "#0a3037", shadowOpacity: 0.09, shadowRadius: 4, elevation: 2 }, tabText: { color: "#718783", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 }, activeTabText: { color: "#0a8c87" },
  content: { padding: 22, paddingBottom: 42, gap: 12 }, list: { gap: 9 },
  empty: { padding: 20, borderRadius: 16, backgroundColor: "#e9f7f5", alignItems: "center", gap: 7 }, emptyTitle: { color: "#0a3037", fontSize: 17, fontWeight: "900" }, muted: { color: "#59716f", fontSize: 11, lineHeight: 16, textAlign: "center" },
  row: { minHeight: 76, padding: 13, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 14, backgroundColor: "white", flexDirection: "row", alignItems: "center", gap: 11 }, rowIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#e9f7f5", alignItems: "center", justifyContent: "center" }, rowBody: { flex: 1, gap: 4 }, rowMeta: { alignItems: "flex-end", gap: 6 }, peerName: { color: "#385753", fontSize: 13, fontWeight: "900" }, preview: { color: "#718783", fontSize: 11 }, time: { color: "#718783", fontSize: 8 },
  back: { minHeight: 42, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 }, actionText: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  conversation: { minHeight: 220, padding: 12, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", gap: 8 }, bubble: { maxWidth: "86%", paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, gap: 3 }, mine: { alignSelf: "flex-end", backgroundColor: "#ccefeb" }, peer: { alignSelf: "flex-start", backgroundColor: "#edf3f2" }, messageText: { color: "#0a3037", fontSize: 14, lineHeight: 19 }, messageFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }, messageStatus: { flexShrink: 1, color: "#718783", fontSize: 8, textTransform: "uppercase" }, resendButton: { minHeight: 30, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 }, resendText: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 0.5 },
  input: { minHeight: 72, maxHeight: 140, padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, color: "#0a3037", backgroundColor: "white", textAlignVertical: "top" }, send: { minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" }, sendText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }, disabled: { opacity: 0.5 }, error: { color: "#b9472f", fontSize: 11, textAlign: "center", marginTop: 4 },
  infoCard: { padding: 22, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 16, backgroundColor: "white", alignItems: "center", gap: 8 }, infoIcon: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#e9f7f5", alignItems: "center", justifyContent: "center", marginBottom: 4 }, infoTitle: { color: "#0a3037", fontSize: 21, fontWeight: "900" }, infoRow: { width: "100%", minHeight: 48, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#dce6e5", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, infoLabel: { color: "#718783", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 }, infoValue: { flex: 1, color: "#0a3037", fontSize: 11, fontWeight: "700", textAlign: "right" },
  sensorHero: { padding: 17, borderRadius: 14, backgroundColor: "#e9f7f5", flexDirection: "row", alignItems: "center", gap: 13 }, sensorHeroText: { flex: 1, gap: 3 }, sensorTitle: { color: "#0a3037", fontSize: 18, fontWeight: "900" }, statsGrid: { gap: 9 }, statCard: { padding: 15, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", gap: 5 }, statLabel: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 }, statValue: { color: "#0a3037", fontSize: 24, fontWeight: "900" }, statRange: { color: "#718783", fontSize: 9, lineHeight: 14 }, sampleTime: { color: "#718783", fontSize: 9, textAlign: "center", marginTop: 4 },
});
