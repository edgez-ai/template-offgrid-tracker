import Ionicons from "@expo/vector-icons/Ionicons";
import {
  Interface, Mime, Operation, edgezNodeDisplayName, edgezNodeId, edgezNodeOpensConversation,
  edgezPublicChannelNode, edgezPublicChannelPorts, encodeNetworkPacket,
} from "@edgez/react-native-sdk";
import type { EdgezConversationMessage } from "@edgez/react-native-sdk";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { localMessageId, nodeNumFromSerial, normalizedDeviceSerial } from "../mesh-utils";
import { displayedMessageStatus, isPeerOnline, peerLastSeenMs } from "../message-delivery";
import { saveProfileMessage } from "../profile-store";
import type { StoredDevice, StoredMessage } from "../profile-store";
import { isPerson } from "./collar-model";
import { connectionSummary } from "./connection";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { useTheme } from "./theme";
import type { KeepteenActions, KeepteenRuntime } from "./types";
import { Button, Card, EmptyState, Field, InfoLine, ListRow, NavHeader, Notice, PageScroll, Screen, StatusDot } from "./ui";

type Peer = { key: string; name: string; serial: string; nodeNum: bigint | null; channel: boolean; device: StoredDevice | null };
type ChatView = { kind: "list" } | { kind: "conversation"; serial: string } | { kind: "profile" };

const sameSerial = (a: string, b: string) => normalizedDeviceSerial(a) === normalizedDeviceSerial(b);

/** Maps the stored delivery state onto the user-facing receipt labels. */
function receiptKey(message: StoredMessage, channel: boolean): MessageKey {
  const raw = displayedMessageStatus(message).toLowerCase();
  if (raw.includes("fail")) return "receiptFailed";
  if (raw.includes("retry")) return "receiptRetrying";
  // Broadcasts never claim delivery or read by everyone.
  if (channel) return raw.includes("send") && !raw.includes("sent") ? "receiptSending" : "receiptSent";
  if (raw.includes("deliver") || raw.includes("ack")) return "receiptDelivered";
  if (raw.includes("sent")) return "receiptSent";
  return "receiptSending";
}

/**
 * Chat product (R02, R11, R12, R29): public channels and teammates belong to
 * the chat device. Text first, then image, then voice. Voice uses the SDK's
 * recorder and chunked voice messages; image transfer has no link yet and says
 * so instead of pretending to send.
 */
export function ChatProduct({ runtime, actions, onClose }: { runtime: KeepteenRuntime; actions: KeepteenActions; onClose: () => void }) {
  const { colors } = useTheme();
  const { t, formatAgo } = useI18n();
  const [view, setView] = useState<ChatView>({ kind: "list" });
  const meshState = runtime.meshLink?.state ?? null;
  const connection = connectionSummary(runtime);

  const channels: Peer[] = edgezPublicChannelPorts
    .map((nodeNum, index) => meshState?.nodes.get(nodeNum) ?? edgezPublicChannelNode(index + 1))
    .filter((node) => node.enabled !== false)
    .map((node) => ({ key: `channel-${node.nodeNum}`, name: edgezNodeDisplayName(node), serial: edgezNodeId(node.nodeNum).toUpperCase(), nodeNum: node.nodeNum, channel: true, device: null }));
  const teammates: Peer[] = runtime.devices.filter((device) => {
    const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
    const live = nodeNum === null ? undefined : meshState?.nodes.get(nodeNum);
    return live ? edgezNodeOpensConversation(live) : isPerson(device);
  }).map((device) => ({
    key: device.id, name: device.name, serial: device.meshMacAddress || device.serial,
    nodeNum: nodeNumFromSerial(device.meshMacAddress || device.serial), channel: false, device,
  }));

  const latest = useMemo(() => {
    const map = new Map<string, StoredMessage>();
    for (const message of runtime.messages) {
      if (message.retryOfUuid) continue;
      const key = normalizedDeviceSerial(message.peerSerial);
      if ((map.get(key)?.timestampMs ?? 0) < message.timestampMs) map.set(key, message);
    }
    return map;
  }, [runtime.messages]);

  if (runtime.onlineMode) {
    return (
      <Screen>
        <NavHeader title={t("productChat")} onBack={onClose} />
        <EmptyState icon="chatbubbles-outline" title={t("chatNeedsLocal")} text={t("chatNeedsLocalHint")} />
      </Screen>
    );
  }

  if (view.kind === "profile") return <ChatProfile runtime={runtime} actions={actions} onBack={() => setView({ kind: "list" })} />;

  if (view.kind === "conversation") {
    const peer = [...channels, ...teammates].find((item) => sameSerial(item.serial, view.serial));
    if (peer) return <Conversation peer={peer} runtime={runtime} actions={actions} onBack={() => setView({ kind: "list" })} />;
  }

  const row = (peer: Peer, last: boolean) => {
    const message = latest.get(normalizedDeviceSerial(peer.serial));
    const online = !peer.channel && isPeerOnline(peer.serial, runtime.devices, meshState);
    const seen = peer.channel ? 0 : peerLastSeenMs(peer.serial, runtime.devices, meshState);
    const preview = message ? (message.voiceBytes.length ? t("voiceMessage") : message.text) : peer.channel ? t("channelHint") : t("startConversation");
    return (
      <Pressable
        key={peer.key}
        style={[styles.peerRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}
        onPress={() => setView({ kind: "conversation", serial: peer.serial })}
        accessibilityRole="button"
        accessibilityLabel={peer.name}
      >
        <View style={[styles.avatar, { backgroundColor: colors.surface }]}>
          <Ionicons name={peer.channel ? "people-outline" : "person-outline"} size={20} color={colors.text} />
          {online ? <View style={[styles.onlineDot, { backgroundColor: colors.online, borderColor: colors.card }]} /> : null}
        </View>
        <View style={styles.flex}>
          <View style={styles.peerTop}>
            <Text style={[styles.peerName, { color: colors.text }]} numberOfLines={1}>{peer.name}</Text>
            {message ? <Text style={[styles.peerTime, { color: colors.secondary }]}>{formatAgo(message.timestampMs)}</Text> : null}
          </View>
          <Text style={[styles.peerPreview, { color: colors.secondary }]} numberOfLines={1}>
            {peer.channel || !seen ? preview : `${preview} · ${t("lastSeen", { ago: formatAgo(seen) })}`}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <Screen>
      <NavHeader
        title={t("productChat")}
        onBack={onClose}
        right={
          <Pressable style={styles.headerIcon} onPress={() => setView({ kind: "profile" })} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("chatProfile")}>
            <Ionicons name="person-circle-outline" size={25} color={colors.text} />
          </Pressable>
        }
      />
      <PageScroll>
        <View style={[styles.summary, { backgroundColor: colors.card }]}>
          <StatusDot tone={connection.tone} />
          <Text style={[styles.summaryText, { color: colors.text }]}>{t(connection.label)}</Text>
        </View>
        <Text style={[styles.group, { color: colors.secondary }]}>{t("publicChannels")}</Text>
        <Card>{channels.map((peer, index) => row(peer, index === channels.length - 1))}</Card>
        <Text style={[styles.group, { color: colors.secondary }]}>{t("teammates")}</Text>
        {teammates.length
          ? <Card>{teammates.map((peer, index) => row(peer, index === teammates.length - 1))}</Card>
          : <EmptyState icon="people-outline" title={t("noTeammates")} text={t("noTeammatesHint")} />}
      </PageScroll>
    </Screen>
  );
}

function Conversation({ peer, runtime, actions, onBack }: { peer: Peer; runtime: KeepteenRuntime; actions: KeepteenActions; onBack: () => void }) {
  const { colors } = useTheme();
  const { t, formatTime } = useI18n();
  const session = runtime.meshLink?.session ?? null;
  const meshState = runtime.meshLink?.state ?? null;
  const node = peer.nodeNum === null ? null : meshState?.nodes.get(peer.nodeNum) ?? null;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordStart, setRecordStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [resending, setResending] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scroll = useRef<ScrollView>(null);
  const ready = Boolean(session && meshState?.bleReady && node);

  const conversation = runtime.messages
    .filter((message) => !message.retryOfUuid && sameSerial(message.peerSerial, peer.serial))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Date.now() - recordStart), 250);
    return () => clearInterval(timer);
  }, [recordStart, recording]);
  // Leaving the conversation stops the microphone.
  useEffect(() => () => { if (session) void session.cancelVoiceMessage().catch(() => undefined); }, [session]);

  const sendText = async () => {
    const value = text.trim();
    if (!session || !node || !value || sending) return;
    setSending(true);
    setError("");
    try {
      if (peer.channel) {
        const from = meshState?.status?.macAddress;
        if (!from) throw new Error(t("localAddressNotReady"));
        const id = localMessageId();
        const packet = encodeNetworkPacket({
          from, to: node.nodeNum, operation: Operation.request, interface: Interface.halow,
          msg: { messageIdHigh: id.high, messageIdLow: id.low, sequence: 1, mime: Mime.text, payload: new TextEncoder().encode(value) },
        });
        await session.sdk.transport.invoke("sendPacket", { label: `Public channel message to ${peer.name}`, packet: Array.from(packet), waitForDrainMs: 3000 });
        await saveProfileMessage(runtime.profile.id, peer.serial, {
          nodeNum: node.nodeNum, text: value, mine: true, timestampMs: Date.now(), messageUuid: id.uuid, status: "Sent",
          voiceBytes: new Uint8Array(), voiceCodec: 0, durationMs: 0,
        });
        await actions.messagesChanged();
      } else {
        // Delivery and retries are tracked by message UUID in message-delivery.ts.
        await session.sendTextMessage(node.nodeNum, value);
      }
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const toggleVoice = async () => {
    if (!session || !node) return;
    setError("");
    try {
      if (!recording) {
        await session.startVoiceMessage();
        setRecordStart(Date.now());
        setElapsed(0);
        setRecording(true);
        return;
      }
      setRecording(false);
      setSending(true);
      const sent = await session.finishVoiceMessage(node.nodeNum);
      if (!sent) throw new Error(t("voiceEmpty"));
    } catch (caught) {
      setRecording(false);
      setError(caught instanceof Error ? caught.message : t("voiceFailed"));
    } finally {
      setSending(false);
    }
  };

  const cancelVoice = async () => {
    setRecording(false);
    if (session) await session.cancelVoiceMessage().catch(() => undefined);
  };

  const play = async (message: StoredMessage) => {
    if (!session || playing) return;
    setPlaying(message.messageUuid);
    try {
      const payload: EdgezConversationMessage = {
        nodeNum: peer.nodeNum ?? 0n, text: message.text, mine: message.mine, timestampMs: message.timestampMs,
        messageUuid: message.messageUuid, status: message.status, voiceBytes: message.voiceBytes,
        voiceCodec: message.voiceCodec, durationMs: message.durationMs,
      };
      await session.playVoiceMessage(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("voicePlayFailed"));
    } finally {
      setPlaying(null);
    }
  };

  const resend = async (message: StoredMessage) => {
    if (resending) return;
    setResending(message.messageUuid);
    setError("");
    try { await actions.resendMessage(message); } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("sendFailed"));
    } finally { setResending(null); }
  };

  return (
    <Screen>
      <NavHeader title={peer.name} onBack={onBack} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {peer.channel ? <Notice text={t("channelReceiptNotice")} /> : null}
          {conversation.length ? conversation.map((message) => {
            const receipt = message.mine ? receiptKey(message, peer.channel) : null;
            const voice = message.voiceBytes.length > 0;
            return (
              <View key={message.messageUuid} style={[styles.bubbleWrap, message.mine ? styles.mineWrap : styles.peerWrap]}>
                <View style={[styles.bubble, { backgroundColor: message.mine ? colors.bubbleMine : colors.bubblePeer }]}>
                  {voice ? (
                    <Pressable style={styles.voice} onPress={() => void play(message)} accessibilityRole="button" accessibilityLabel={t("playVoice")}>
                      {playing === message.messageUuid
                        ? <ActivityIndicator size="small" color={message.mine ? colors.onBubbleMine : colors.text} />
                        : <Ionicons name="play" size={18} color={message.mine ? colors.onBubbleMine : colors.text} />}
                      <Text style={[styles.messageText, { color: message.mine ? colors.onBubbleMine : colors.text }]}>
                        {t("voiceMessage")} · {Math.max(1, Math.round(message.durationMs / 1000))}″
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={[styles.messageText, { color: message.mine ? colors.onBubbleMine : colors.text }]} selectable>{message.text}</Text>
                  )}
                </View>
                <View style={styles.meta}>
                  <Text style={[styles.metaText, { color: receipt === "receiptFailed" ? colors.danger : colors.secondary }]}>
                    {formatTime(message.timestampMs)}{receipt ? ` · ${t(receipt)}` : ""}
                  </Text>
                  {receipt === "receiptFailed" ? (
                    <Pressable onPress={() => void resend(message)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("resend")}>
                      {resending === message.messageUuid ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={[styles.resend, { color: colors.accent }]}>{t("resend")}</Text>}
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          }) : <EmptyState icon="chatbubble-ellipses-outline" title={t("noMessages")} text={peer.channel ? t("channelFirstMessage") : t("firstMessageHint")} />}
        </ScrollView>

        {!node ? <View style={styles.notice}><Notice tone="warning" text={t("peerIdentityIncomplete")} /></View> : null}
        {node && !meshState?.bleReady ? <View style={styles.notice}><Notice tone="warning" text={t("chatNotReady")} /></View> : null}
        {error ? <View style={styles.notice}><Notice tone="danger" text={error} /></View> : null}

        {recording ? (
          <View style={[styles.composer, { backgroundColor: colors.card, borderTopColor: colors.separator }]}>
            <Pressable style={styles.tool} onPress={() => void cancelVoice()} accessibilityRole="button" accessibilityLabel={t("cancel")}>
              <Ionicons name="close" size={24} color={colors.danger} />
            </Pressable>
            <Text style={[styles.recording, { color: colors.text }]}>{t("recording", { seconds: Math.floor(elapsed / 1000) })}</Text>
            <Pressable style={[styles.send, { backgroundColor: colors.primary }]} onPress={() => void toggleVoice()} accessibilityRole="button" accessibilityLabel={t("sendVoice")}>
              <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />
            </Pressable>
          </View>
        ) : (
          <View style={[styles.composer, { backgroundColor: colors.card, borderTopColor: colors.separator }]}>
            <Pressable
              style={styles.tool}
              onPress={() => Alert.alert(t("sendImage"), t("imageNotAvailable"))}
              accessibilityRole="button"
              accessibilityLabel={t("sendImage")}
            >
              <Ionicons name="image-outline" size={23} color={colors.secondary} />
            </Pressable>
            <Pressable
              style={[styles.tool, (!ready || peer.channel) && styles.dim]}
              onPress={() => peer.channel ? Alert.alert(t("voiceMessage"), t("voiceChannelUnavailable")) : void toggleVoice()}
              disabled={!ready || sending}
              accessibilityRole="button"
              accessibilityLabel={t("recordVoice")}
            >
              <Ionicons name="mic-outline" size={23} color={colors.secondary} />
            </Pressable>
            <TextInput
              style={[styles.input, { backgroundColor: colors.surface, color: colors.text }]}
              value={text}
              onChangeText={setText}
              placeholder={t("messagePlaceholder")}
              placeholderTextColor={colors.secondary}
              multiline
            />
            <Pressable
              style={[styles.send, { backgroundColor: colors.primary }, (!text.trim() || !ready || sending) && styles.dim]}
              onPress={() => void sendText()}
              disabled={!text.trim() || !ready || sending}
              accessibilityRole="button"
              accessibilityLabel={t("send")}
            >
              {sending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** Chat nickname and mesh identity belong to the chat product (R29). */
function ChatProfile({ runtime, actions, onBack }: { runtime: KeepteenRuntime; actions: KeepteenActions; onBack: () => void }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const [name, setName] = useState(runtime.sharedSettings.identityName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!name.trim()) { setError(t("nameRequired")); return; }
    setSaving(true);
    setError("");
    try {
      await actions.saveSharedSettings({ ...runtime.sharedSettings, identityName: name.trim() });
      onBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("saveFailed"));
    } finally { setSaving(false); }
  };
  return (
    <Screen>
      <NavHeader title={t("chatProfile")} onBack={onBack} />
      <PageScroll>
        <Field label={t("nickname")} value={name} onChangeText={setName} maxLength={64} error={error || undefined} />
        <Text style={[styles.hint, { color: colors.secondary }]}>{t("nicknameHint")}</Text>
        <Card>
          <InfoLine label={t("identityId")} value={runtime.sharedSettings.identityId || t("unknown")} last />
        </Card>
        <Button label={t("save")} onPress={() => void save()} loading={saving} />
        <Card>
          <ListRow icon="options-outline" title={t("beaconAndLocation")} subtitle={t("beaconAndLocationHint")} onPress={actions.openAdvancedSettings} last />
        </Card>
      </PageScroll>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  summary: { borderRadius: 14, minHeight: 44, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  summaryText: { flex: 1, fontSize: 14 },
  group: { fontSize: 13, marginLeft: 4, marginTop: 6 },
  peerRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  onlineDot: { position: "absolute", right: 0, bottom: 0, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  peerTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  peerName: { flex: 1, fontSize: 16, fontWeight: "500" },
  peerTime: { fontSize: 12 },
  peerPreview: { fontSize: 14, marginTop: 2 },
  messages: { padding: 16, gap: 10, flexGrow: 1 },
  bubbleWrap: { maxWidth: "82%", gap: 3 },
  mineWrap: { alignSelf: "flex-end", alignItems: "flex-end" },
  peerWrap: { alignSelf: "flex-start", alignItems: "flex-start" },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  messageText: { fontSize: 16, lineHeight: 21 },
  voice: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  meta: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 },
  metaText: { fontSize: 12 },
  resend: { fontSize: 12, fontWeight: "600" },
  notice: { paddingHorizontal: 16, paddingBottom: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 4, paddingHorizontal: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  tool: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  dim: { opacity: 0.4 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", margin: 2 },
  hint: { fontSize: 13, marginHorizontal: 4, lineHeight: 18 },
  recording: { flex: 1, fontSize: 16, textAlign: "center", alignSelf: "center" },
});
