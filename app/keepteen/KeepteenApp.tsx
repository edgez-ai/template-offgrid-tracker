import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatProduct } from "./ChatProduct";
import { CollarProduct } from "./CollarProduct";
import { DevicesHome } from "./DevicesHome";
import type { ProductKey } from "./DevicesHome";
import { SettingsHome, SettingsPage } from "./SettingsPages";
import type { SettingsPageKey } from "./SettingsPages";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import type { KeepteenActions, KeepteenRuntime } from "./types";
import { Button, Notice, Screen } from "./ui";

export function KeepteenStartup({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 16 }}>
        {onRetry ? <>
          <Text style={{ color: colors.text, fontSize: 20 }}>{t("startupFailed")}</Text>
          {error ? <Notice tone="danger" text={error} /> : null}
          <Button label={t("tryAgain")} onPress={onRetry} />
        </> : <ActivityIndicator color={colors.accent} size="large" />}
      </View>
    </Screen>
  );
}

type RootTab = "devices" | "settings";
type Route =
  | { kind: "root" }
  | { kind: "product"; product: Exclude<ProductKey, "valve" | "camera"> }
  | { kind: "settings"; page: SettingsPageKey };

/**
 * KEEPTEEN shell. Root navigation is only "Devices / Settings" (R01); product
 * pages and settings sub-pages hide it. Chat is entered from its product card,
 * never from a global tab (R02).
 */
export function KeepteenApp({ runtime, actions }: { runtime: KeepteenRuntime; actions: KeepteenActions }) {
  const [tab, setTab] = useState<RootTab>("devices");
  const [route, setRoute] = useState<Route>({ kind: "root" });

  // Profile switches reset any product page bound to the previous profile.
  useEffect(() => { setRoute((current) => current.kind === "product" ? { kind: "root" } : current); }, [runtime.profile.id]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (route.kind === "root") {
        if (tab === "settings") { setTab("devices"); return true; }
        return false;
      }
      setRoute({ kind: "root" });
      return true;
    });
    return () => subscription.remove();
  }, [route.kind, tab]);

  if (route.kind === "product" && route.product === "collar") {
    return <CollarProduct runtime={runtime} actions={actions} onClose={() => setRoute({ kind: "root" })} />;
  }
  if (route.kind === "product" && route.product === "chat") {
    return <ChatProduct runtime={runtime} actions={actions} onClose={() => setRoute({ kind: "root" })} />;
  }
  if (route.kind === "settings") {
    return <SettingsPage page={route.page} runtime={runtime} actions={actions} onBack={() => setRoute({ kind: "root" })} />;
  }

  return (
    <Screen edges={["top", "left", "right"]}>
      <View style={styles.flex}>
        {tab === "devices"
          ? <DevicesHome runtime={runtime} onAddDevice={actions.addDevice} onOpenProduct={(product) => {
              if (product === "collar" || product === "chat") setRoute({ kind: "product", product });
            }} />
          : <SettingsHome runtime={runtime} onOpen={(page) => setRoute({ kind: "settings", page })} />}
      </View>
      <TabBar tab={tab} onChange={setTab} />
    </Screen>
  );
}

function TabBar({ tab, onChange }: { tab: RootTab; onChange: (tab: RootTab) => void }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const items: ReadonlyArray<{ key: RootTab; icon: React.ComponentProps<typeof Ionicons>["name"]; label: string }> = [
    { key: "devices", icon: tab === "devices" ? "grid" : "grid-outline", label: t("tabDevices") },
    { key: "settings", icon: tab === "settings" ? "settings" : "settings-outline", label: t("tabSettings") },
  ];
  return (
    <View
      style={[styles.tabBar, { backgroundColor: colors.card, borderTopColor: colors.separator, paddingBottom: Math.max(insets.bottom, 6) }]}
      accessibilityRole="tablist"
    >
      {items.map((item) => {
        const selected = item.key === tab;
        return (
          <Pressable key={item.key} style={styles.tabItem} onPress={() => onChange(item.key)} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label}>
            <Ionicons name={item.icon} size={23} color={selected ? colors.text : colors.secondary} />
            <Text style={[styles.tabLabel, { color: selected ? colors.text : colors.secondary }, selected && styles.tabLabelSelected]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // R30: two entries pulled toward the centre (108×48 each, ≤28 px gap).
  tabBar: { flexDirection: "row", justifyContent: "center", gap: 28, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  tabItem: { width: 108, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 2 },
  tabLabel: { fontSize: 11 },
  tabLabelSelected: { fontWeight: "600" },
});
