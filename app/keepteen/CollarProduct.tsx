import Ionicons from "@expo/vector-icons/Ionicons";
import { edgezNodeId } from "@edgez/react-native-sdk";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MeshMessages } from "../MeshMessages";
import { BleDebugModal } from "../SettingsScreens";
import { updateCloudDevice } from "../cloud-auth";
import { coordinatesFromLocation } from "../mesh-utils";
import { CollarMap } from "./CollarMap";
import type { CollarMapMarker } from "./CollarMap";
import { FenceEditor } from "./FenceEditor";
import { buildCollarNodes, displayName, groupSamples, isGateway, loadNodeAliases, saveNodeAliases } from "./collar-model";
import type { CollarNode, Freshness } from "./collar-model";
import { connectionSummary } from "./connection";
import { areaReminders, fenceLines, loadFences, saveFences } from "./fences";
import type { Fence } from "./fences";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { useTheme } from "./theme";
import type { KeepteenActions, KeepteenRuntime } from "./types";
import { Button, Card, Chip, EmptyState, Field, InfoLine, ListRow, NavHeader, Notice, PageScroll, Screen, Segmented, StatusDot } from "./ui";
import type { StatusTone } from "./ui";

type Tab = "nodes" | "map" | "fences";
type Filter = "all" | Freshness;
type View_ = { kind: "workbench" } | { kind: "node"; id: string } | { kind: "fence"; id: string | null } | { kind: "connection" };

const PAGE_SIZE = 20;
const freshnessTone: Record<Freshness, StatusTone> = { recent: "online", stale: "warning", never: "idle" };
const freshnessLabel: Record<Freshness, MessageKey> = { recent: "freshRecent", stale: "freshStale", never: "freshNever" };

/** Collar product: gateway workbench → nodes / map / fences → node detail (R08–R10). */
export function CollarProduct({ runtime, actions, onClose }: { runtime: KeepteenRuntime; actions: KeepteenActions; onClose: () => void }) {
  const { colors } = useTheme();
  const { t, formatAgo } = useI18n();
  const [view, setView] = useState<View_>({ kind: "workbench" });
  const [tab, setTab] = useState<Tab>("nodes");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [fences, setFences] = useState<Fence[]>([]);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [legacyInbox, setLegacyInbox] = useState<{ peer: string | null; tab: "sensors" | "discovered" } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void loadNodeAliases(runtime.profile.id).then(setAliases);
    void loadFences(runtime.profile.id).then(setFences);
  }, [runtime.profile.id]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const meshState = runtime.meshLink?.state ?? null;
  const samples = useMemo(
    () => runtime.onlineMode ? groupSamples(runtime.cloudSensorSamples) : meshState?.sensorSamples ?? new Map(),
    [meshState?.sensorSamples, runtime.cloudSensorSamples, runtime.onlineMode],
  );
  const nodes = useMemo(() => buildCollarNodes(runtime.devices, meshState, samples, now), [meshState, now, runtime.devices, samples]);
  const gateways = runtime.devices.filter(isGateway);
  const connection = connectionSummary(runtime);
  const waiting = runtime.provisioningRequests.filter((request) => request.status !== "accepted").length;
  const { reminders, unevaluated } = useMemo(() => areaReminders(fences, nodes, now), [fences, nodes, now]);
  const openReminders = reminders.filter((item) => !acknowledged.has(item.key));

  const visible = nodes.filter((node) => {
    if (filter !== "all" && node.freshness !== filter) return false;
    const search = query.trim().toLowerCase();
    if (!search) return true;
    return [displayName(node, aliases), node.device.name, node.device.serial, node.device.meshMacAddress]
      .some((value) => value.toLowerCase().includes(search));
  }).sort((a, b) => b.lastReportMs - a.lastReportMs);

  const persistFences = async (next: Fence[]) => {
    setFences(next);
    await saveFences(runtime.profile.id, next);
  };
  const persistAlias = async (deviceId: string, alias: string) => {
    const next = { ...aliases };
    if (alias.trim()) next[deviceId] = alias.trim(); else delete next[deviceId];
    setAliases(next);
    await saveNodeAliases(runtime.profile.id, next);
  };

  const markers: CollarMapMarker[] = nodes
    .filter((node) => node.latitude !== null && node.longitude !== null)
    .map((node) => ({ id: node.device.id, label: displayName(node, aliases), latitude: node.latitude!, longitude: node.longitude!, marker: node.device.marker }));
  const fallbackCenter = coordinatesFromLocation(runtime.profile.location);

  const legacy = legacyInbox ? (
    <MeshMessages
      visible
      profile={runtime.profile}
      profileId={runtime.profile.id}
      session={runtime.meshLink?.session ?? null}
      meshState={meshState}
      devices={runtime.devices}
      messages={runtime.messages}
      provisioningRequests={runtime.provisioningRequests}
      cloudSensorSamples={runtime.cloudSensorSamples}
      onlineMode={runtime.onlineMode}
      initialPeerSerial={legacyInbox.peer}
      initialTab={legacyInbox.tab}
      onMessagesChanged={actions.messagesChanged}
      onDevicesChanged={actions.devicesChanged}
      onProvisioningRequestsChanged={actions.provisioningRequestsChanged}
      onResendMessage={actions.resendMessage}
      onShowDevice={(device) => { setLegacyInbox(null); setView({ kind: "node", id: device.id }); }}
      onRemoveDevice={actions.removeDevice}
      onClose={() => setLegacyInbox(null)}
    />
  ) : null;

  if (view.kind === "node") {
    const node = nodes.find((item) => item.device.id === view.id);
    return <>
      <NodeDetail
        node={node ?? null}
        runtime={runtime}
        aliases={aliases}
        onBack={() => setView({ kind: "workbench" })}
        onSaveAlias={persistAlias}
        onSharedRenamed={actions.devicesChanged}
        onOpenHistory={(serial) => setLegacyInbox({ peer: serial, tab: "sensors" })}
        onShowOnMap={() => { setTab("map"); setView({ kind: "workbench" }); }}
        onRemove={(device) => { actions.removeDevice(device); setView({ kind: "workbench" }); }}
      />
      {legacy}
    </>;
  }

  if (view.kind === "fence") {
    const fence = view.id ? fences.find((item) => item.id === view.id) ?? null : null;
    return (
      <FenceEditor
        profileId={runtime.profile.id}
        fence={fence}
        nodes={nodes}
        aliases={aliases}
        fallbackCenter={markers[0] ?? fallbackCenter}
        onCancel={() => setView({ kind: "workbench" })}
        onSave={async (saved) => {
          await persistFences(fence ? fences.map((item) => item.id === saved.id ? saved : item) : [...fences, saved]);
          setView({ kind: "workbench" });
        }}
        onDelete={fence ? async () => {
          await persistFences(fences.filter((item) => item.id !== fence.id));
          setView({ kind: "workbench" });
        } : undefined}
      />
    );
  }

  if (view.kind === "connection") {
    return <ConnectionPage runtime={runtime} gatewayCount={gateways.length} onBack={() => setView({ kind: "workbench" })} onAddDevice={actions.addDevice} />;
  }

  return (
    <Screen>
      <NavHeader
        title={t("productCollar")}
        onBack={onClose}
        right={
          <Pressable style={styles.headerIcon} onPress={() => setView({ kind: "connection" })} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("connectionDetails")}>
            <Ionicons name="information-circle-outline" size={24} color={colors.text} />
          </Pressable>
        }
      />
      <Pressable style={[styles.summary, { backgroundColor: colors.card }]} onPress={() => setView({ kind: "connection" })} accessibilityRole="button">
        <StatusDot tone={connection.tone} />
        <Text style={[styles.summaryText, { color: colors.text }]} numberOfLines={1}>
          {t(connection.label)}{gateways.length ? ` · ${t("gatewayCount", { count: gateways.length })}` : ""} · {t("collarCount", { count: nodes.length })}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.secondary} />
      </Pressable>
      <View style={styles.tabs}>
        <Segmented<Tab>
          options={[{ key: "nodes", label: t("tabNodes") }, { key: "map", label: t("tabMap") }, { key: "fences", label: t("tabFences") }]}
          value={tab}
          onChange={setTab}
        />
      </View>

      {tab === "map" ? (
        <View style={styles.mapPage}>
          <CollarMap
            markers={markers}
            lines={fenceLines(fences, colors.accent)}
            fallbackCenter={fallbackCenter}
            onSelect={(id) => setView({ kind: "node", id })}
          />
          {!markers.length ? <View style={styles.mapNotice}><Notice text={t("mapNoLocatedNodes")} /></View> : null}
        </View>
      ) : null}

      {tab === "nodes" ? (
        <PageScroll>
          {waiting ? (
            <Pressable onPress={() => setLegacyInbox({ peer: null, tab: "discovered" })} accessibilityRole="button">
              <Card style={styles.banner}>
                <Ionicons name="radio-outline" size={20} color={colors.accent} />
                <Text style={[styles.bannerText, { color: colors.text }]}>{t("waitingCollars", { count: waiting })}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.secondary} />
              </Card>
            </Pressable>
          ) : null}
          {openReminders.length ? (
            <Pressable onPress={() => setTab("fences")} accessibilityRole="button">
              <Card style={styles.banner}>
                <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
                <Text style={[styles.bannerText, { color: colors.text }]}>{t("areaReminderCount", { count: openReminders.length })}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.secondary} />
              </Card>
            </Pressable>
          ) : null}
          <View style={[styles.search, { backgroundColor: colors.card }]}>
            <Ionicons name="search" size={17} color={colors.secondary} />
            <TextInput
              style={[styles.searchInput, { color: colors.text }]}
              value={query}
              onChangeText={(value) => { setQuery(value); setLimit(PAGE_SIZE); }}
              placeholder={t("searchCollars")}
              placeholderTextColor={colors.secondary}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.chips}>
            {(["all", "recent", "stale", "never"] as const).map((key) => (
              <Chip key={key} label={key === "all" ? t("filterAll") : t(freshnessLabel[key])} selected={filter === key} onPress={() => { setFilter(key); setLimit(PAGE_SIZE); }} />
            ))}
          </View>
          {visible.length ? (
            <Card>
              {visible.slice(0, limit).map((node, index, list) => (
                <NodeRow key={node.device.id} node={node} name={displayName(node, aliases)} last={index === list.length - 1} onPress={() => setView({ kind: "node", id: node.device.id })} />
              ))}
            </Card>
          ) : (
            <EmptyState
              icon="paw-outline"
              title={nodes.length ? t("noMatchingCollars") : t("noCollarsTitle")}
              text={nodes.length ? undefined : runtime.onlineMode ? t("noCollarsCloud") : connection.tone === "online" ? t("noCollarsReady") : t("noCollarsOffline")}
            />
          )}
          {visible.length > limit ? <Button kind="secondary" label={t("loadMore")} onPress={() => setLimit((value) => value + PAGE_SIZE)} /> : null}
          {runtime.meshLink === null && !runtime.onlineMode && nodes.length ? <Notice text={t("cachedNodesNotice")} /> : null}
        </PageScroll>
      ) : null}

      {tab === "fences" ? (
        <PageScroll>
          <Notice text={t("fenceLocalNotice")} />
          {openReminders.length ? <>
            <Text style={[styles.groupLabel, { color: colors.secondary }]}>{t("areaReminders")}</Text>
            <Card>
              {openReminders.map((item, index) => (
                <ListRow
                  key={item.key}
                  icon={item.kind === "outside" ? "exit-outline" : "enter-outline"}
                  title={t(item.kind === "outside" ? "reminderOutside" : "reminderInside", { node: displayName(item.node, aliases), fence: item.fence.name })}
                  subtitle={t("reminderBasedOn", { ago: formatAgo(item.atMs) })}
                  last={index === openReminders.length - 1}
                  accessory={
                    <Pressable style={styles.ack} onPress={() => setAcknowledged((current) => new Set(current).add(item.key))} accessibilityRole="button">
                      <Text style={[styles.ackText, { color: colors.accent }]}>{t("acknowledge")}</Text>
                    </Pressable>
                  }
                />
              ))}
            </Card>
          </> : null}
          {unevaluated ? <Notice tone="warning" text={t("fenceUnevaluated", { count: unevaluated })} /> : null}
          {fences.length ? (
            <Card>
              {fences.map((fence, index) => (
                <ListRow
                  key={fence.id}
                  icon="shapes-outline"
                  title={fence.name}
                  subtitle={`${t(`shape_${fence.shape}` as MessageKey)} · ${t("fenceNodeCount", { count: fence.deviceIds.length })} · ${fence.enabled ? t("fenceSavedHere") : t("fencePaused")}`}
                  onPress={() => setView({ kind: "fence", id: fence.id })}
                  last={index === fences.length - 1}
                />
              ))}
            </Card>
          ) : <EmptyState icon="shapes-outline" title={t("noFencesTitle")} text={t("noFencesText")} />}
          <Button label={t("addFence")} icon="add" onPress={() => setView({ kind: "fence", id: null })} disabled={!nodes.length} />
          {!nodes.length ? <Text style={[styles.hint, { color: colors.secondary }]}>{t("fenceNeedsNodes")}</Text> : null}
        </PageScroll>
      ) : null}
      {legacy}
    </Screen>
  );
}

function NodeRow({ node, name, last, onPress }: { node: CollarNode; name: string; last: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const { t, formatAgo } = useI18n();
  const parts = [
    node.lastReportMs ? formatAgo(node.lastReportMs) : t("freshNever"),
    node.batteryVolts !== null ? `${node.batteryVolts.toFixed(2)} V` : null,
    node.latitude !== null ? t("hasLocation") : t("noLocation"),
  ].filter(Boolean).join(" · ");
  return (
    <Pressable style={[styles.nodeRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]} onPress={onPress} accessibilityRole="button" accessibilityLabel={name}>
      <StatusDot tone={freshnessTone[node.freshness]} />
      <View style={styles.nodeBody}>
        <Text style={[styles.nodeName, { color: colors.text }]} numberOfLines={2}>{name}</Text>
        <Text style={[styles.nodeMeta, { color: colors.secondary }]} numberOfLines={1}>{parts}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.secondary} />
    </Pressable>
  );
}

function NodeDetail({ node, runtime, aliases, onBack, onSaveAlias, onSharedRenamed, onOpenHistory, onShowOnMap, onRemove }: {
  node: CollarNode | null;
  runtime: KeepteenRuntime;
  aliases: Record<string, string>;
  onBack: () => void;
  onSaveAlias: (deviceId: string, alias: string) => Promise<void>;
  onSharedRenamed: () => Promise<void>;
  onOpenHistory: (serial: string) => void;
  onShowOnMap: () => void;
  onRemove: (device: CollarNode["device"]) => void;
}) {
  const { colors } = useTheme();
  const { t, formatAgo, formatDateTime } = useI18n();
  const [editing, setEditing] = useState<"alias" | "shared" | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!node) {
    return <Screen><NavHeader title={t("productCollar")} onBack={onBack} /><EmptyState icon="help-circle-outline" title={t("nodeGone")} /></Screen>;
  }
  const name = displayName(node, aliases);
  const serial = node.device.meshMacAddress || node.device.serial;
  const sharedRename = runtime.onlineMode && runtime.cloudStatus === "online";

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      if (editing === "alias") await onSaveAlias(node.device.id, draft);
      else {
        const value = draft.trim();
        if (!value) throw new Error(t("nameRequired"));
        if (value.length > 64) throw new Error(t("nameTooLong"));
        await updateCloudDevice(node.device.id, {
          name: value,
          markerType: node.device.iconStyle,
          markerColor: node.device.marker,
          latitude: node.device.latitude,
          longitude: node.device.longitude,
        });
        await onSharedRenamed();
      }
      setEditing(null);
    } catch (caught) {
      // Keep the typed value so the user can retry.
      setError(caught instanceof Error ? caught.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <NavHeader title={name} onBack={onBack} />
      <PageScroll>
        <Card style={styles.hero}>
          <StatusDot tone={freshnessTone[node.freshness]} />
          <View style={styles.flex}>
            <Text style={[styles.heroName, { color: colors.text }]}>{name}</Text>
            <Text style={[styles.nodeMeta, { color: colors.secondary }]}>{t(freshnessLabel[node.freshness])}</Text>
          </View>
        </Card>

        {editing ? (
          <Card style={styles.editCard}>
            <Field
              label={editing === "alias" ? t("localAlias") : t("sharedName")}
              value={draft}
              onChangeText={setDraft}
              maxLength={64}
              autoFocus
              error={error || undefined}
            />
            <Text style={[styles.hint, { color: colors.secondary }]}>{editing === "alias" ? t("localAliasHint") : t("sharedNameHint")}</Text>
            <View style={styles.editActions}>
              <View style={styles.flex}><Button kind="secondary" label={t("cancel")} onPress={() => { setEditing(null); setError(""); }} /></View>
              <View style={styles.flex}><Button label={t("save")} onPress={() => void save()} loading={saving} /></View>
            </View>
          </Card>
        ) : (
          <Card>
            <ListRow icon="pencil-outline" title={t("editLocalAlias")} subtitle={aliases[node.device.id] ? node.device.name : undefined} onPress={() => { setDraft(aliases[node.device.id] ?? ""); setEditing("alias"); }} last={!sharedRename} />
            {sharedRename ? <ListRow icon="cloud-outline" title={t("editSharedName")} onPress={() => { setDraft(node.device.name); setEditing("shared"); }} last /> : null}
          </Card>
        )}

        <Card>
          <InfoLine label={t("lastReport")} value={node.lastReportMs ? `${formatAgo(node.lastReportMs)} · ${formatDateTime(node.lastReportMs)}` : t("unknown")} />
          <InfoLine
            label={t("battery")}
            value={node.batteryVolts !== null ? `${node.batteryVolts.toFixed(2)} V · ${formatAgo(node.batteryAtMs)}` : t("unknown")}
          />
          <InfoLine
            label={t("signal")}
            value={node.rssiDbm !== null
              ? `${node.rssiDbm} dBm · ${node.rssiReporter !== null ? t("reportedBy", { node: edgezNodeId(node.rssiReporter).toUpperCase() }) : ""} · ${formatAgo(node.rssiAtMs)}`
              : t("unknown")}
          />
          <InfoLine
            label={t("location")}
            value={node.latitude !== null && node.longitude !== null
              ? `${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)} (WGS84)${node.locationAtMs ? ` · ${formatAgo(node.locationAtMs)}` : ""}`
              : t("noLocation")}
            last
          />
        </Card>
        {node.latitude !== null ? <Button kind="secondary" icon="map-outline" label={t("showOnMap")} onPress={onShowOnMap} /> : null}
        <Button kind="secondary" icon="stats-chart-outline" label={t("dataHistory")} onPress={() => onOpenHistory(serial)} />

        <Text style={[styles.groupLabel, { color: colors.secondary }]}>{t("details")}</Text>
        <Card>
          <InfoLine label={t("hardwareName")} value={node.device.name || "—"} />
          <InfoLine label={t("deviceNumber")} value={serial || "—"} />
          <InfoLine label={t("firmware")} value={node.device.firmwareTarget || t("unknown")} />
          <InfoLine label={t("reportPeriod")} value={t("unknown")} last />
        </Card>
        <Button
          kind="danger"
          label={t("removeFromProfile")}
          onPress={() => Alert.alert(t("removeFromProfile"), t("removeFromProfileHint", { name }), [
            { text: t("cancel"), style: "cancel" },
            { text: t("remove"), style: "destructive", onPress: () => onRemove(node.device) },
          ])}
        />
      </PageScroll>
    </Screen>
  );
}

function ConnectionPage({ runtime, gatewayCount, onBack, onAddDevice }: { runtime: KeepteenRuntime; gatewayCount: number; onBack: () => void; onAddDevice: () => void }) {
  const { t, formatAgo } = useI18n();
  const [diagnostics, setDiagnostics] = useState(false);
  const status = runtime.meshLink?.state.status;
  return (
    <Screen>
      <NavHeader title={t("connectionDetails")} onBack={onBack} />
      <PageScroll>
        <Card>
          {runtime.onlineMode ? (
            <InfoLine label={t("cloud")} value={t(connectionSummary(runtime).label)} last />
          ) : <>
            <InfoLine label={t("controller")} value={runtime.sharedSettings.bleDeviceName || runtime.profile.bleDeviceName || t("statusNoController")} />
            <InfoLine label={t("bluetooth")} value={`${runtime.bleStatus.label} · ${formatAgo(runtime.bleStatus.updatedAt)}`} />
            <InfoLine label="HaLow" value={runtime.bleStatus.halowLinkUp === null ? t("unknown") : runtime.bleStatus.halowLinkUp ? t("halowUp") : t("halowDown")} />
            <InfoLine label={t("firmware")} value={status?.firmwareVersion || t("unknown")} />
            <InfoLine label={t("deviceNumber")} value={status?.macAddress ? edgezNodeId(status.macAddress).toUpperCase() : t("unknown")} last />
          </>}
        </Card>
        <Card>
          <InfoLine label={t("gateways")} value={String(gatewayCount)} />
          <InfoLine label={t("halowNetwork")} value={`${runtime.profile.meshId} · ${runtime.profile.country}`} last />
        </Card>
        {!runtime.onlineMode ? <Button kind="secondary" icon="pulse-outline" label={t("diagnostics")} onPress={() => setDiagnostics(true)} /> : null}
        <Button kind="secondary" icon="add" label={t("addDevice")} onPress={onAddDevice} />
        <Notice text={t("sharedLinkNotice")} />
      </PageScroll>
      <BleDebugModal visible={diagnostics} status={runtime.bleStatus} onClose={() => setDiagnostics(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  summary: { marginHorizontal: 16, borderRadius: 14, minHeight: 44, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  summaryText: { flex: 1, fontSize: 14 },
  tabs: { paddingHorizontal: 16, paddingTop: 12 },
  mapPage: { flex: 1, padding: 16 },
  mapNotice: { position: "absolute", left: 28, right: 28, bottom: 28 },
  banner: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52 },
  bannerText: { flex: 1, fontSize: 15 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, paddingHorizontal: 12, minHeight: 44 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  nodeRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 10 },
  nodeBody: { flex: 1 },
  nodeName: { fontSize: 16, fontWeight: "500" },
  nodeMeta: { fontSize: 13, marginTop: 2 },
  groupLabel: { fontSize: 13, marginLeft: 4, marginTop: 6 },
  ack: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  ackText: { fontSize: 14, fontWeight: "600" },
  hint: { fontSize: 13, lineHeight: 18 },
  hero: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  heroName: { fontSize: 20, fontWeight: "600" },
  editCard: { paddingVertical: 14, gap: 10 },
  editActions: { flexDirection: "row", gap: 10 },
});
