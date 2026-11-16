import React, { useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { CollarMap } from "./CollarMap";
import type { CollarMapHandle } from "./CollarMap";
import { displayName } from "./collar-model";
import type { CollarNode } from "./collar-model";
import { fenceOutline, newFenceId, validateFence } from "./fences";
import type { Fence, FenceShape, LatLon } from "./fences";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { useTheme } from "./theme";
import { Button, Card, Chip, Field, ListRow, NavHeader, Notice, PageScroll, Screen, Segmented, SwitchRow } from "./ui";

const shapes: FenceShape[] = ["circle", "oval", "rectangle", "polygon"];

function num(value: string) {
  const parsed = Number(value.replace(",", "."));
  return value.trim() === "" ? NaN : parsed;
}

/**
 * Full-page fence form (handoff: long forms use a whole page; precise
 * coordinates and rotation live under "Details"). The map crosshair sets the
 * centre or appends polygon vertices.
 */
export function FenceEditor({ profileId, fence, nodes, aliases, fallbackCenter, onCancel, onSave, onDelete }: {
  profileId: string;
  fence: Fence | null;
  nodes: CollarNode[];
  aliases: Record<string, string>;
  fallbackCenter: LatLon | null;
  onCancel: () => void;
  onSave: (fence: Fence) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const map = useRef<CollarMapHandle>(null);
  const start = fence?.geometry.center ?? fallbackCenter ?? { latitude: 59.3293, longitude: 18.0686 };
  const [name, setName] = useState(fence?.name ?? "");
  const [shape, setShape] = useState<FenceShape>(fence?.shape ?? "circle");
  const [latitude, setLatitude] = useState(String(start.latitude.toFixed(6)));
  const [longitude, setLongitude] = useState(String(start.longitude.toFixed(6)));
  const [radius, setRadius] = useState(String(fence?.geometry.radiusMeters ?? 200));
  const [radiusX, setRadiusX] = useState(String(fence?.geometry.radiusXMeters ?? 300));
  const [radiusY, setRadiusY] = useState(String(fence?.geometry.radiusYMeters ?? 150));
  const [width, setWidth] = useState(String(fence?.geometry.widthMeters ?? 400));
  const [height, setHeight] = useState(String(fence?.geometry.heightMeters ?? 250));
  const [rotation, setRotation] = useState(String(fence?.geometry.rotationDegrees ?? 0));
  const [vertices, setVertices] = useState<LatLon[]>(fence?.geometry.vertices ?? []);
  const [deviceIds, setDeviceIds] = useState<string[]>(fence?.deviceIds ?? nodes.map((node) => node.device.id));
  const [enterAlert, setEnterAlert] = useState(fence?.enterAlert ?? false);
  const [exitAlert, setExitAlert] = useState(fence?.exitAlert ?? true);
  const [enabled, setEnabled] = useState(fence?.enabled ?? true);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<MessageKey | "">("");
  const [saving, setSaving] = useState(false);

  const draft = (): Fence => ({
    id: fence?.id ?? newFenceId(),
    profileId,
    name: name.trim(),
    shape,
    geometry: shape === "polygon"
      ? { center: vertices[0] ?? { latitude: num(latitude), longitude: num(longitude) }, vertices }
      : {
          center: { latitude: num(latitude), longitude: num(longitude) },
          rotationDegrees: shape === "circle" ? undefined : num(rotation) || 0,
          ...(shape === "circle" ? { radiusMeters: num(radius) } : {}),
          ...(shape === "oval" ? { radiusXMeters: num(radiusX), radiusYMeters: num(radiusY) } : {}),
          ...(shape === "rectangle" ? { widthMeters: num(width), heightMeters: num(height) } : {}),
        },
    deviceIds,
    enterAlert,
    exitAlert,
    enabled,
    createdAt: fence?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const preview = draft();
  const previewValid = !validateFence({ ...preview, name: preview.name || "x", deviceIds: ["x"], enterAlert: true });
  const lines = previewValid ? [{ id: "draft", points: fenceOutline(preview), color: colors.accent }] : [];

  const useMapCenter = () => {
    const camera = map.current?.camera();
    if (!camera) return;
    if (shape === "polygon") setVertices((current) => [...current, { latitude: camera.latitude, longitude: camera.longitude }]);
    else { setLatitude(camera.latitude.toFixed(6)); setLongitude(camera.longitude.toFixed(6)); }
  };

  const save = async () => {
    const value = draft();
    const problem = validateFence(value);
    setError(problem ?? "");
    if (problem) return;
    setSaving(true);
    try { await onSave(value); } finally { setSaving(false); }
  };

  return (
    <Screen>
      <NavHeader title={fence ? t("editFence") : t("addFence")} onBack={onCancel} />
      <PageScroll>
        <CollarMap
          ref={map}
          markers={nodes.filter((node) => node.latitude !== null && node.longitude !== null).map((node) => ({
            id: node.device.id, label: displayName(node, aliases), latitude: node.latitude!, longitude: node.longitude!, marker: node.device.marker,
          }))}
          lines={lines}
          fallbackCenter={start}
          crosshair
          height={260}
        />
        <Button kind="secondary" icon="locate-outline" label={shape === "polygon" ? t("addVertexAtCenter") : t("setCenterFromMap")} onPress={useMapCenter} />
        {shape === "polygon" ? (
          <View style={styles.row}>
            <Text style={[styles.hint, { color: colors.secondary }]}>{t("vertexCount", { count: vertices.length })}</Text>
            {vertices.length ? <Button kind="secondary" label={t("removeLastVertex")} onPress={() => setVertices((current) => current.slice(0, -1))} /> : null}
          </View>
        ) : null}

        <Field label={t("fenceName")} value={name} onChangeText={setName} maxLength={64} placeholder={t("fenceNamePlaceholder")} />
        <Segmented<FenceShape> options={shapes.map((key) => ({ key, label: t(`shape_${key}` as MessageKey) }))} value={shape} onChange={setShape} />

        {shape === "circle" ? <Field label={t("radiusMeters")} value={radius} onChangeText={setRadius} keyboardType="numeric" /> : null}
        {shape === "oval" ? <View style={styles.row}>
          <View style={styles.flex}><Field label={t("radiusXMeters")} value={radiusX} onChangeText={setRadiusX} keyboardType="numeric" /></View>
          <View style={styles.flex}><Field label={t("radiusYMeters")} value={radiusY} onChangeText={setRadiusY} keyboardType="numeric" /></View>
        </View> : null}
        {shape === "rectangle" ? <View style={styles.row}>
          <View style={styles.flex}><Field label={t("widthMeters")} value={width} onChangeText={setWidth} keyboardType="numeric" /></View>
          <View style={styles.flex}><Field label={t("heightMeters")} value={height} onChangeText={setHeight} keyboardType="numeric" /></View>
        </View> : null}

        <Card>
          <ListRow title={t("details")} subtitle={t("fenceDetailsHint")} onPress={() => setDetails((value) => !value)} last />
        </Card>
        {details ? <>
          {shape !== "polygon" ? <View style={styles.row}>
            <View style={styles.flex}><Field label={t("latitude")} value={latitude} onChangeText={setLatitude} keyboardType="numbers-and-punctuation" /></View>
            <View style={styles.flex}><Field label={t("longitude")} value={longitude} onChangeText={setLongitude} keyboardType="numbers-and-punctuation" /></View>
          </View> : null}
          {shape === "oval" || shape === "rectangle" ? <Field label={t("rotationDegrees")} value={rotation} onChangeText={setRotation} keyboardType="numbers-and-punctuation" /> : null}
          {shape === "polygon" && vertices.length ? <Card>
            {vertices.map((vertex, index) => (
              <ListRow key={`${vertex.latitude}:${vertex.longitude}:${index}`} title={`${index + 1}. ${vertex.latitude.toFixed(5)}, ${vertex.longitude.toFixed(5)}`} last={index === vertices.length - 1} />
            ))}
          </Card> : null}
        </> : null}

        <Text style={[styles.label, { color: colors.secondary }]}>{t("fenceNodes")}</Text>
        <View style={styles.chips}>
          <Chip label={t("selectAll")} selected={deviceIds.length === nodes.length && nodes.length > 0} onPress={() => setDeviceIds(nodes.map((node) => node.device.id))} />
          <Chip label={t("selectNone")} selected={!deviceIds.length} onPress={() => setDeviceIds([])} />
        </View>
        <Card>
          {nodes.map((node, index) => {
            const selected = deviceIds.includes(node.device.id);
            return (
              <SwitchRow
                key={node.device.id}
                title={displayName(node, aliases)}
                value={selected}
                onChange={(next) => setDeviceIds((current) => next ? [...current, node.device.id] : current.filter((id) => id !== node.device.id))}
                last={index === nodes.length - 1}
              />
            );
          })}
        </Card>
        <Notice text={t("fenceSnapshotNotice")} />

        <Card>
          <SwitchRow title={t("alertOnExit")} value={exitAlert} onChange={setExitAlert} />
          <SwitchRow title={t("alertOnEnter")} value={enterAlert} onChange={setEnterAlert} />
          <SwitchRow title={t("fenceEnabled")} value={enabled} onChange={setEnabled} last />
        </Card>

        {error ? <Notice tone="danger" text={t(error)} /> : null}
        <Button label={t("save")} onPress={() => void save()} loading={saving} />
        {onDelete ? <Button kind="danger" label={t("deleteFence")} onPress={() => Alert.alert(t("deleteFence"), t("deleteFenceHint", { name: fence?.name ?? "" }), [
          { text: t("cancel"), style: "cancel" },
          { text: t("delete"), style: "destructive", onPress: () => void onDelete() },
        ])} /> : null}
      </PageScroll>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", gap: 10, alignItems: "center", justifyContent: "space-between" },
  chips: { flexDirection: "row", gap: 8 },
  label: { fontSize: 13, marginLeft: 4, marginTop: 4 },
  hint: { fontSize: 13 },
});
