import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { artwork } from "./assets";
import type { ArtworkKey } from "./assets";
import { collarDevices } from "./collar-model";
import { connectionSummary } from "./connection";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n";
import { useTheme } from "./theme";
import type { KeepteenRuntime } from "./types";
import { StatusDot } from "./ui";
import type { StatusTone } from "./ui";

export type ProductKey = "collar" | "chat" | "valve" | "camera";
type Area = "all" | "pasture" | "garden" | "warehouse";

const areas: ReadonlyArray<{ key: Area; label: MessageKey }> = [
  { key: "all", label: "areaAll" },
  { key: "pasture", label: "areaPasture" },
  { key: "garden", label: "areaGarden" },
  { key: "warehouse", label: "areaWarehouse" },
];

/**
 * Home (R04, R05, R39): title "Devices", area tabs, a bordered add button and
 * four product cards under "All". Other areas are display-only and empty —
 * there is no area-assignment service yet.
 */
export function DevicesHome({ runtime, onOpenProduct, onAddDevice, cameraCount = 0 }: {
  runtime: KeepteenRuntime;
  cameraCount?: number;
  onOpenProduct: (product: ProductKey) => void;
  onAddDevice: () => void;
}) {
  const { colors, mode } = useTheme();
  const { t } = useI18n();
  const [area, setArea] = useState<Area>("all");
  const connection = connectionSummary(runtime);
  const collarConnection = connectionSummary(runtime, true);
  const collars = collarDevices(runtime.devices).length;

  const cards: ReadonlyArray<{ key: ProductKey; art: ArtworkKey; title: string; status: string; tone: StatusTone }> = [
    {
      key: "collar",
      art: "collar",
      title: t("productCollar"),
      status: collars ? t("collarCount", { count: collars }) : t(collarConnection.label),
      tone: collarConnection.tone,
    },
    {
      key: "chat",
      art: "chat",
      title: t("productChat"),
      status: runtime.onlineMode ? t("chatNeedsLocal") : t(connection.label),
      tone: runtime.onlineMode ? "idle" : connection.tone,
    },
    { key: "valve", art: "valve", title: t("productValve"), status: t("comingSoon"), tone: "idle" },
    { key: "camera", art: "camera", title: t("productCamera"), status: cameraCount ? String(cameraCount) : t("comingSoon"), tone: cameraCount ? "online" : "idle" },
  ];

  const open = (product: ProductKey) => {
    if (product === "valve" || (product === "camera" && runtime.onlineMode)) {
      Alert.alert(t(product === "valve" ? "productValve" : "productCamera"), t("productNotOpen"));
      return;
    }
    onOpenProduct(product);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{t("tabDevices")}</Text>
        <Pressable
          style={[styles.addButton, { borderColor: colors.separator, backgroundColor: colors.card }]}
          onPress={onAddDevice}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t("addDevice")}
        >
          <Ionicons name="add" size={22} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.areas} accessibilityRole="tablist">
        {areas.map((item) => {
          const selected = item.key === area;
          return (
            <Pressable key={item.key} onPress={() => setArea(item.key)} style={styles.areaTab} accessibilityRole="tab" accessibilityState={{ selected }}>
              <Text style={[styles.areaText, { color: selected ? colors.text : colors.secondary }, selected && styles.areaTextSelected]}>{t(item.label)}</Text>
              <View style={[styles.areaUnderline, { backgroundColor: selected ? colors.accent : "transparent" }]} />
            </Pressable>
          );
        })}
      </ScrollView>

      {area === "all" ? (
        <View style={styles.grid}>
          {cards.map((card) => (
            <Pressable
              key={card.key}
              style={({ pressed }) => [styles.card, { backgroundColor: colors.card }, pressed && styles.pressed]}
              onPress={() => open(card.key)}
              accessibilityRole="button"
              accessibilityLabel={`${card.title}, ${card.status}`}
            >
              <View style={styles.artBox}>
                <View style={[styles.halo, { backgroundColor: colors.surface }]} />
                <Image source={artwork(mode, card.art)} style={styles.art} resizeMode="contain" />
              </View>
              <Text style={[styles.cardTitle, { color: colors.text }]}>{card.title}</Text>
              <View style={styles.statusRow}>
                <StatusDot tone={card.tone} />
                <Text style={[styles.cardStatus, { color: colors.secondary }]} numberOfLines={2}>{card.status}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={[styles.emptyArea, { backgroundColor: colors.card }]}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t("areaEmpty")}</Text>
          <Text style={[styles.emptyText, { color: colors.secondary }]}>{t("areaEmptyHint")}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 52 },
  title: { fontSize: 30, fontWeight: "700" },
  // R37: 36×36 bordered, thin plus, 44×44 hit area via hitSlop.
  addButton: { width: 36, height: 36, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: "center", justifyContent: "center" },
  areas: { gap: 22, paddingVertical: 6 },
  areaTab: { minHeight: 40, justifyContent: "center", alignItems: "center" },
  areaText: { fontSize: 16 },
  areaTextSelected: { fontWeight: "700" },
  areaUnderline: { height: 3, width: 18, borderRadius: 2, marginTop: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12, marginTop: 12 },
  card: { width: "48.3%", minHeight: 132, borderRadius: 20, padding: 14 },
  pressed: { opacity: 0.75 },
  artBox: { height: 64, width: 78, justifyContent: "center", alignItems: "center", marginBottom: 8 },
  halo: { position: "absolute", width: 58, height: 44, borderRadius: 29, opacity: 0.65 },
  art: { width: 78, height: 64 },
  cardTitle: { fontSize: 17, fontWeight: "600" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  cardStatus: { flex: 1, fontSize: 13 },
  emptyArea: { borderRadius: 20, padding: 24, marginTop: 12, alignItems: "center", gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: "600" },
  emptyText: { fontSize: 14, textAlign: "center" },
});
