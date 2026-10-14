import Ionicons from "@expo/vector-icons/Ionicons";
import { Interface, Mime, Operation, edgezNodeDisplayName, edgezNodeId, edgezNodeOpensConversation, encodeNetworkPacket, isEdgezPublicChannel } from "@edgez/react-native-sdk";
import type { EdgezMeshSession, EdgezMeshState } from "@edgez/react-native-sdk";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { localMessageId, nodeNumFromSerial, normalizedDeviceSerial } from "./mesh-utils";
import { saveProfileMessage } from "./profile-store";
import type { StoredDevice, StoredMessage } from "./profile-store";

export function MeshMessages({
  visible,
  profileId,
  session,
  meshState,
  devices,
  messages,
  initialPeerSerial,
  onMessagesChanged,
  onClose,
}: {
  visible: boolean;
  profileId: string;
  session: EdgezMeshSession | null;
  meshState: EdgezMeshState | null;
  devices: StoredDevice[];
  messages: StoredMessage[];
  initialPeerSerial: string | null;
  onMessagesChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const userDevices = devices.filter((device) => {
    const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
    const liveNode = nodeNum === null ? undefined : meshState?.nodes.get(nodeNum);
    if (liveNode) return edgezNodeOpensConversation(liveNode);
    const type = device.deviceType.trim().toLowerCase();
    return !type || type === "unspecified" || type === "user" || type === "device_type_user";
  });
  const channelPeers = [...(meshState?.nodes.values() ?? [])]
    .filter((node) => isEdgezPublicChannel(node.nodeNum) && node.enabled !== false)
    .map((node) => ({
      id: `channel-${node.nodeNum}`,
      name: edgezNodeDisplayName(node),
      serial: edgezNodeId(node.nodeNum).toUpperCase(),
      nodeNum: node.nodeNum,
      publicChannel: true,
    }));
  const userPeers = userDevices.map((device) => ({
    id: device.id,
    name: device.name,
    serial: device.meshMacAddress || device.serial,
    nodeNum: nodeNumFromSerial(device.meshMacAddress || device.serial),
    publicChannel: false,
  }));
  const peers = [...channelPeers, ...userPeers];
  const [selectedPeerSerial, setSelectedPeerSerial] = useState<string | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const selectedPeer = selectedPeerSerial
    ? peers.find((peer) => normalizedDeviceSerial(peer.serial) === normalizedDeviceSerial(selectedPeerSerial)) ?? null
    : null;
  const selectedNode = selectedPeer?.nodeNum === null || selectedPeer?.nodeNum === undefined
    ? null
    : meshState?.nodes.get(selectedPeer.nodeNum) ?? null;
  const conversation = selectedPeer
    ? messages.filter((item) => normalizedDeviceSerial(item.peerSerial) === normalizedDeviceSerial(selectedPeer.serial))
    : [];

  useEffect(() => {
    if (visible) setSelectedPeerSerial(initialPeerSerial);
  }, [initialPeerSerial, visible]);

  const send = async () => {
    const text = message.trim();
    if (!session || !selectedNode || !selectedPeer || !text || sending) return;
    setSending(true);
    setError("");
    try {
      if (selectedPeer.publicChannel) {
        const from = meshState?.status?.macAddress;
        if (!from) throw new Error("Local HaLow address is not ready.");
        const id = localMessageId();
        const packet = encodeNetworkPacket({
          from,
          to: selectedNode.nodeNum,
          operation: Operation.request,
          interface: Interface.halow,
          msg: {
            messageIdHigh: id.high,
            messageIdLow: id.low,
            sequence: 1,
            mime: Mime.text,
            payload: new TextEncoder().encode(text),
          },
        });
        await session.sdk.transport.invoke("sendPacket", {
          label: `Public channel message to ${selectedPeer.name}`,
          packet: Array.from(packet),
          waitForDrainMs: 3000,
        });
        await saveProfileMessage(profileId, selectedPeer.serial, {
          nodeNum: selectedNode.nodeNum,
          text,
          mine: true,
          timestampMs: Date.now(),
          messageUuid: id.uuid,
          status: "Sent",
          voiceBytes: new Uint8Array(),
          voiceCodec: 0,
          durationMs: 0,
        });
        await onMessagesChanged();
      } else {
        await session.sendTextMessage(selectedNode.nodeNum, text);
      }
      setMessage("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the mesh message.");
    } finally {
      setSending(false);
    }
  };

  const conversationRow = (peer: (typeof peers)[number]) => {
    const peerMessages = messages.filter((item) =>
      normalizedDeviceSerial(item.peerSerial) === normalizedDeviceSerial(peer.serial));
    const latest = peerMessages[peerMessages.length - 1];
    return (
      <Pressable key={peer.id} style={styles.row} onPress={() => setSelectedPeerSerial(peer.serial)} accessibilityRole="button">
        <View style={styles.icon}><Ionicons name={peer.publicChannel ? "people-outline" : "person-outline"} size={20} color="#0a8c87" /></View>
        <View style={styles.rowBody}>
          <Text style={styles.peerName}>{peer.name}</Text>
          <Text style={styles.preview} numberOfLines={1}>{latest?.text || (peer.publicChannel ? "Send to everyone on this channel" : "Start a mesh conversation")}</Text>
        </View>
        <View style={styles.rowMeta}>
          <Text style={styles.time}>{latest ? new Date(latest.timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</Text>
          <Ionicons name="chevron-forward" size={17} color="#718783" />
        </View>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.page}>
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>OFFGRID MESSAGES</Text><Text style={styles.title}>{selectedPeer ? selectedPeer.name : "Messages"}</Text></View>
          <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8} accessibilityRole="button"><Text style={styles.close}>CLOSE</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {!peers.length ? (
            <View style={styles.empty}><Text style={styles.emptyTitle}>Waiting for another profile</Text><Text style={styles.muted}>Peers appear here after their periodic beacon reaches this device over BATMAN.</Text></View>
          ) : !selectedPeer ? (
            <>
              <Pressable style={styles.sectionHeader} onPress={() => setChannelsOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: channelsOpen }}>
                <View><Text style={styles.sectionTitle}>Channels</Text><Text style={styles.sectionCount}>{channelPeers.length} public channels</Text></View>
                <Ionicons name={channelsOpen ? "chevron-up" : "chevron-down"} size={20} color="#0a8c87" />
              </Pressable>
              {channelsOpen ? <View style={styles.list}>{channelPeers.map(conversationRow)}</View> : null}
              {userPeers.length ? <><Text style={styles.sectionLabel}>PEOPLE</Text><View style={styles.list}>{userPeers.map(conversationRow)}</View></> : null}
            </>
          ) : (
            <>
              <Pressable style={styles.back} onPress={() => setSelectedPeerSerial(null)} accessibilityRole="button"><Ionicons name="chevron-back" size={18} color="#0a8c87" /><Text style={styles.actionText}>ALL CONVERSATIONS</Text></Pressable>
              <View style={styles.conversation}>
                {!conversation.length ? <Text style={styles.muted}>No messages yet.</Text> : conversation.map((item) => (
                  <View key={item.messageUuid} style={[styles.bubble, item.mine ? styles.mine : styles.peer]}>
                    <Text style={styles.messageText}>{item.text}</Text>
                    <Text style={styles.messageStatus}>{item.mine ? item.status || "Sending" : selectedPeer.name} · {new Date(item.timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
                  </View>
                ))}
              </View>
              <TextInput style={styles.input} value={message} onChangeText={setMessage} placeholder="Message over HaLow mesh" placeholderTextColor="#718783" multiline />
              <Pressable style={[styles.send, (!message.trim() || sending || !meshState?.bleReady || !selectedNode) && styles.disabled]} disabled={!message.trim() || sending || !meshState?.bleReady || !selectedNode} onPress={() => void send()} accessibilityRole="button">
                {sending ? <ActivityIndicator color="white" /> : <Text style={styles.sendText}>SEND OVER MESH</Text>}
              </Pressable>
              {!selectedNode ? <Text style={styles.error}>The cached device identity is incomplete. Wait for one beacon to refresh it.</Text> : null}
              {selectedNode && !meshState?.bleReady ? <Text style={styles.error}>BLE control channel is not ready.</Text> : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f7faf9" },
  header: { minHeight: 84, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  eyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  title: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  closeButton: { minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" },
  close: { color: "#59716f", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 },
  content: { padding: 22, paddingBottom: 42, gap: 12 },
  empty: { padding: 20, borderRadius: 16, backgroundColor: "#e9f7f5", gap: 6 },
  emptyTitle: { color: "#0a3037", fontSize: 18, fontWeight: "900" },
  muted: { color: "#59716f", fontSize: 11, lineHeight: 16 },
  list: { gap: 9 },
  sectionHeader: { minHeight: 68, paddingHorizontal: 15, borderWidth: 1, borderColor: "#b9dad6", borderRadius: 14, backgroundColor: "#e9f7f5", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#0a3037", fontSize: 16, fontWeight: "900" },
  sectionCount: { color: "#718783", fontSize: 10, marginTop: 3 },
  sectionLabel: { color: "#718783", fontSize: 9, fontWeight: "900", letterSpacing: 1, marginTop: 8 },
  row: { minHeight: 76, padding: 13, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 14, backgroundColor: "white", flexDirection: "row", alignItems: "center", gap: 11 },
  icon: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#e9f7f5", alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, gap: 4 },
  rowMeta: { alignItems: "flex-end", gap: 6 },
  peerName: { color: "#385753", fontSize: 13, fontWeight: "900" },
  preview: { color: "#718783", fontSize: 11 },
  time: { color: "#718783", fontSize: 9 },
  back: { minHeight: 42, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
  actionText: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  conversation: { minHeight: 220, padding: 12, borderWidth: 1, borderColor: "#dce6e5", borderRadius: 14, backgroundColor: "white", gap: 8 },
  bubble: { maxWidth: "86%", paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, gap: 3 },
  mine: { alignSelf: "flex-end", backgroundColor: "#ccefeb" },
  peer: { alignSelf: "flex-start", backgroundColor: "#edf3f2" },
  messageText: { color: "#0a3037", fontSize: 14, lineHeight: 19 },
  messageStatus: { color: "#718783", fontSize: 8, textTransform: "uppercase" },
  input: { minHeight: 72, maxHeight: 140, padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, color: "#0a3037", backgroundColor: "white", textAlignVertical: "top" },
  send: { minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  sendText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  disabled: { opacity: 0.5 },
  error: { color: "#b9472f", fontSize: 11, textAlign: "center", marginTop: 4 },
});
