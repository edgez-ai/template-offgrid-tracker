import Ionicons from "@expo/vector-icons/Ionicons";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

const overview = [
  { icon: "radio-outline" as const, label: "Devices", value: "0" },
  { icon: "git-network-outline" as const, label: "Mesh links", value: "0" },
  { icon: "notifications-outline" as const, label: "Alerts", value: "0" },
];

function HomePage() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>OFFGRID TRACKER</Text>
            <Text style={styles.title}>Home</Text>
          </View>
          <View style={styles.localBadge}>
            <View style={styles.localDot} />
            <Text style={styles.localBadgeText}>LOCAL</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="map-outline" size={30} color="#092e35" />
          </View>
          <Text style={styles.heroTitle}>Your off-grid network</Text>
          <Text style={styles.heroCopy}>
            Device setup and mesh management are available without a cloud account.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>OVERVIEW</Text>
        <View style={styles.overviewRow}>
          {overview.map((item) => (
            <View key={item.label} style={styles.overviewCard}>
              <Ionicons name={item.icon} size={22} color="#0a8c87" />
              <Text style={styles.overviewValue}>{item.value}</Text>
              <Text style={styles.overviewLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Ionicons name="add-circle-outline" size={34} color="#0a8c87" />
          </View>
          <View style={styles.emptyText}>
            <Text style={styles.emptyTitle}>No devices added</Text>
            <Text style={styles.emptyCopy}>
              Your trackers and gateways will appear here after local provisioning.
            </Text>
          </View>
        </View>

        <View style={styles.privacyCard}>
          <Ionicons name="shield-checkmark-outline" size={24} color="#69cfc7" />
          <View style={styles.privacyText}>
            <Text style={styles.privacyTitle}>Standalone by default</Text>
            <Text style={styles.privacyCopy}>
              The app now opens directly to Home and does not require Appwrite configuration or sign-in.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <HomePage />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#092e35" },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 32 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  eyebrow: { color: "#69cfc7", fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  title: { color: "#ffffff", fontSize: 32, fontWeight: "800", marginTop: 3 },
  localBadge: { flexDirection: "row", alignItems: "center", gap: 7, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: "#123f47" },
  localDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#69cfc7" },
  localBadgeText: { color: "#d8f5f1", fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  hero: { borderRadius: 24, padding: 22, backgroundColor: "#dff4ef", marginBottom: 28 },
  heroIcon: { width: 54, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#ffffff", marginBottom: 26 },
  heroTitle: { color: "#092e35", fontSize: 25, lineHeight: 30, fontWeight: "800" },
  heroCopy: { color: "#36565b", fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 310 },
  sectionTitle: { color: "#8db2b5", fontSize: 10, fontWeight: "900", letterSpacing: 1.4, marginBottom: 10 },
  overviewRow: { flexDirection: "row", gap: 10, marginBottom: 24 },
  overviewCard: { flex: 1, minHeight: 124, borderRadius: 18, padding: 14, backgroundColor: "#ffffff" },
  overviewValue: { color: "#092e35", fontSize: 28, fontWeight: "800", marginTop: 15 },
  overviewLabel: { color: "#59716f", fontSize: 11, fontWeight: "700", marginTop: 2 },
  emptyState: { flexDirection: "row", alignItems: "center", borderRadius: 20, padding: 18, backgroundColor: "#ffffff", marginBottom: 14 },
  emptyIcon: { width: 54, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#eaf7f4" },
  emptyText: { flex: 1, marginLeft: 14 },
  emptyTitle: { color: "#092e35", fontSize: 16, fontWeight: "800" },
  emptyCopy: { color: "#59716f", fontSize: 13, lineHeight: 19, marginTop: 4 },
  privacyCard: { flexDirection: "row", alignItems: "flex-start", borderRadius: 20, padding: 18, backgroundColor: "#123f47" },
  privacyText: { flex: 1, marginLeft: 13 },
  privacyTitle: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  privacyCopy: { color: "#b7d7d8", fontSize: 13, lineHeight: 19, marginTop: 4 },
});
