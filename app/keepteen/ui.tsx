import Ionicons from "@expo/vector-icons/Ionicons";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

export function Screen({ children, edges }: { children: React.ReactNode; edges?: ("top" | "bottom" | "left" | "right")[] }) {
  const { colors, mode } = useTheme();
  return (
    <SafeAreaView style={[base.flex, { backgroundColor: colors.canvas }]} edges={edges ?? ["top", "left", "right", "bottom"]}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      {children}
    </SafeAreaView>
  );
}

/** Second-level page header: "‹ Back" on the left, centred title (R38). */
export function NavHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={base.navHeader}>
      <View style={base.navSide}>
        {onBack ? (
          <Pressable style={base.backButton} onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel={t("back")}>
            <Ionicons name="chevron-back" size={22} color={colors.text} />
            <Text style={[base.backText, { color: colors.text }]}>{t("back")}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={[base.navTitle, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
      <View style={[base.navSide, base.navRight]}>{right}</View>
    </View>
  );
}

export function PageScroll({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <ScrollView contentContainerStyle={[base.pageContent, style]} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return <View style={[base.card, { backgroundColor: colors.card }, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: string }) {
  const { colors } = useTheme();
  return <Text style={[base.sectionLabel, { color: colors.secondary }]}>{children}</Text>;
}

export function ListRow({
  icon, title, subtitle, value, onPress, last, tone, accessory,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  onPress?: () => void;
  last?: boolean;
  tone?: "danger";
  accessory?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const content = (
    <View style={[base.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
      {icon ? <Ionicons name={icon} size={21} color={tone === "danger" ? colors.danger : colors.text} style={base.rowIcon} /> : null}
      <View style={base.flex}>
        <Text style={[base.rowTitle, { color: tone === "danger" ? colors.danger : colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[base.rowSubtitle, { color: colors.secondary }]}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={[base.rowValue, { color: colors.secondary }]} numberOfLines={1}>{value}</Text> : null}
      {accessory}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.secondary} /> : null}
    </View>
  );
  if (!onPress) return content;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>{content}</Pressable>;
}

export function InfoLine({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[base.infoLine, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
      <Text style={[base.infoLabel, { color: colors.secondary }]}>{label}</Text>
      <Text style={[base.infoValue, { color: colors.text }]} selectable>{value}</Text>
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: ReadonlyArray<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[base.segmented, { backgroundColor: colors.surface }]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            style={[base.segment, selected && { backgroundColor: colors.card }]}
            onPress={() => onChange(option.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
          >
            <Text style={[base.segmentText, { color: selected ? colors.text : colors.secondary }]} numberOfLines={1}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[base.chip, { borderColor: selected ? colors.accent : colors.separator, backgroundColor: selected ? colors.card : "transparent" }]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={[base.chipText, { color: selected ? colors.text : colors.secondary }]}>{label}</Text>
    </Pressable>
  );
}

export function Button({ label, onPress, kind = "primary", disabled, loading, icon }: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
}) {
  const { colors } = useTheme();
  const background = kind === "primary" ? colors.primary : colors.card;
  const foreground = kind === "primary" ? colors.onPrimary : kind === "danger" ? colors.danger : colors.text;
  return (
    <Pressable
      style={[base.button, { backgroundColor: background, borderColor: kind === "primary" ? colors.primary : colors.separator }, (disabled || loading) && base.disabled]}
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
    >
      {loading ? <ActivityIndicator color={foreground} /> : <>
        {icon ? <Ionicons name={icon} size={18} color={foreground} /> : null}
        <Text style={[base.buttonText, { color: foreground }]}>{label}</Text>
      </>}
    </Pressable>
  );
}

export function Notice({ text, tone = "info" }: { text: string; tone?: "info" | "warning" | "danger" }) {
  const { colors } = useTheme();
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.secondary;
  const icon: IconName = tone === "info" ? "information-circle-outline" : "alert-circle-outline";
  return (
    <View style={[base.notice, { backgroundColor: colors.surface }]}>
      <Ionicons name={icon} size={17} color={color} />
      <Text style={[base.noticeText, { color }]}>{text}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, text }: { icon: IconName; title: string; text?: string }) {
  const { colors } = useTheme();
  return (
    <View style={base.empty}>
      <Ionicons name={icon} size={30} color={colors.secondary} />
      <Text style={[base.emptyTitle, { color: colors.text }]}>{title}</Text>
      {text ? <Text style={[base.emptyText, { color: colors.secondary }]}>{text}</Text> : null}
    </View>
  );
}

export type StatusTone = "online" | "warning" | "danger" | "idle";

export function StatusDot({ tone }: { tone: StatusTone }) {
  const { colors } = useTheme();
  const color = tone === "online" ? colors.online : tone === "warning" ? colors.warning : tone === "danger" ? colors.danger : colors.secondary;
  return <View style={[base.dot, { backgroundColor: color }]} />;
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const { colors } = useTheme();
  return (
    <View style={base.field}>
      <Text style={[base.fieldLabel, { color: colors.secondary }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.secondary}
        {...props}
        style={[base.input, { backgroundColor: colors.card, color: colors.text, borderColor: error ? colors.danger : colors.separator }, props.style]}
      />
      {error ? <Text style={[base.fieldError, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

export function SwitchRow({ title, subtitle, value, onChange, last }: { title: string; subtitle?: string; value: boolean; onChange: (value: boolean) => void; last?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      style={[base.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <View style={base.flex}>
        <Text style={[base.rowTitle, { color: colors.text }]}>{title}</Text>
        {subtitle ? <Text style={[base.rowSubtitle, { color: colors.secondary }]}>{subtitle}</Text> : null}
      </View>
      <View style={[base.switchTrack, { backgroundColor: value ? colors.accent : colors.surface }]}>
        <View style={[base.switchThumb, value && base.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

export const base = StyleSheet.create({
  flex: { flex: 1 },
  navHeader: { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  navSide: { width: 96, flexDirection: "row", alignItems: "center" },
  navRight: { justifyContent: "flex-end", paddingRight: 8 },
  navTitle: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
  backButton: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingRight: 8 },
  backText: { fontSize: 16 },
  pageContent: { padding: 16, paddingBottom: 40, gap: 12 },
  card: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 4 },
  sectionLabel: { fontSize: 13, marginTop: 8, marginLeft: 4 },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  rowIcon: { width: 24 },
  rowTitle: { fontSize: 16 },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  rowValue: { fontSize: 15, maxWidth: "45%" },
  infoLine: { paddingVertical: 11, gap: 3 },
  infoLabel: { fontSize: 13 },
  infoValue: { fontSize: 16 },
  segmented: { flexDirection: "row", borderRadius: 10, padding: 3 },
  segment: { flex: 1, minHeight: 34, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  segmentText: { fontSize: 14, fontWeight: "600" },
  chip: { minHeight: 34, borderRadius: 17, borderWidth: 1, paddingHorizontal: 14, justifyContent: "center" },
  chipText: { fontSize: 14, fontWeight: "500" },
  button: { minHeight: 48, borderRadius: 14, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 18 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  notice: { flexDirection: "row", gap: 8, borderRadius: 12, padding: 12, alignItems: "flex-start" },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  empty: { alignItems: "center", paddingVertical: 36, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "600", textAlign: "center" },
  emptyText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, marginLeft: 4 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 16 },
  fieldError: { fontSize: 13, marginLeft: 4 },
  switchTrack: { width: 50, height: 30, borderRadius: 15, padding: 2, justifyContent: "center" },
  switchThumb: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#FFFFFF" },
  switchThumbOn: { alignSelf: "flex-end" },
});
