import Ionicons from "@expo/vector-icons/Ionicons";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BleLinkStatus } from "./ActiveProfileBleLink";
import { styles } from "./app-styles";
import type { StoredProfile } from "./profile-store";

export function BleDebugModal({
  visible,
  status,
  onClose,
}: {
  visible: boolean;
  status: BleLinkStatus;
  onClose: () => void;
}) {
  const halowLinkLabel = status.halowLinkUp === null
    ? "WAITING"
    : status.halowLinkUp
      ? "UP"
      : "DOWN";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.bleDebugBackdrop}>
        <View style={styles.bleDebugCard}>
          <View style={styles.bleDebugHeader}>
            <View>
              <Text style={styles.bleDebugEyebrow}>LIVE DEVICE STATUS</Text>
              <Text style={styles.bleDebugTitle}>BLE debug</Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text style={styles.settingsClose}>CLOSE</Text>
            </Pressable>
          </View>
          <View style={styles.bleDebugHalowRow}>
            <View style={[
              styles.bleDebugHalowDot,
              status.halowLinkUp === true && styles.bleStatusDotReady,
              status.halowLinkUp === false && styles.bleStatusDotError,
            ]} />
            <View style={styles.bleDebugHalowBody}>
              <Text style={styles.bleDebugHalowLabel}>HALOW LINK</Text>
              <Text style={styles.bleDebugHalowValue}>{halowLinkLabel}</Text>
            </View>
            <Text style={styles.bleDebugLive}>LIVE</Text>
          </View>
          <Text style={styles.bleDebugSummary}>{status.label}</Text>
          <Text style={styles.bleDebugUpdated}>
            Last update: {new Date(status.updatedAt).toLocaleTimeString()}
          </Text>
          <ScrollView style={styles.bleDebugDetails} contentContainerStyle={styles.bleDebugDetailsContent}>
            {status.details.map((detail) => (
              <Text key={detail} style={styles.bleDebugDetail}>{detail}</Text>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function SettingsPage({
  profiles,
  currentProfile,
  bleStatus,
  managerOpen,
  busy,
  error,
  onClose,
  onManage,
  onBack,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
}: {
  profiles: StoredProfile[];
  currentProfile: StoredProfile;
  bleStatus: BleLinkStatus;
  managerOpen: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onManage: () => void;
  onBack: () => void;
  onSelect: (profile: StoredProfile) => void;
  onCreate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [debugOpen, setDebugOpen] = useState(false);

  return (
    <SafeAreaView style={styles.settingsPage}>
      <StatusBar style="dark" />
      <View style={styles.settingsHeader}>
        <View>
          <Text style={styles.settingsEyebrow}>SETTINGS</Text>
          <Text style={styles.settingsTitle}>{managerOpen ? "Profile management" : "Profile settings"}</Text>
        </View>
        <Pressable onPress={managerOpen ? onBack : onClose} disabled={busy} accessibilityRole="button">
          <Text style={styles.settingsClose}>{managerOpen ? "BACK" : "CLOSE"}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.settingsContent} keyboardShouldPersistTaps="handled">
        {managerOpen ? (
          <>
            <Text style={styles.settingsSectionLabel}>PROFILES</Text>
            {profiles.map((profile) => {
              const selected = profile.id === currentProfile.id;
              return (
                <Pressable
                  key={profile.id}
                  style={[styles.profileRow, selected && styles.profileRowSelected]}
                  onPress={() => onSelect(profile)}
                  disabled={busy || selected}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: busy || selected }}
                >
                  <View style={styles.profileRowBody}>
                    <Text style={styles.profileRowName}>{profile.name}</Text>
                    <Text style={styles.settingsMuted}>
                      {profile.country} · {profile.halowChannel === 0 ? "Auto" : `Channel ${profile.halowChannel}`} · {profile.meshId}
                    </Text>
                  </View>
                  <Text style={[styles.profileRowStatus, selected && styles.profileRowStatusSelected]}>
                    {selected ? "CURRENT" : "SELECT"}
                  </Text>
                </Pressable>
              );
            })}

            <View style={styles.settingsActions}>
              <Pressable style={styles.settingsPrimaryButton} onPress={onEdit} disabled={busy} accessibilityRole="button">
                <Text style={styles.settingsPrimaryText}>EDIT PROFILE</Text>
              </Pressable>
              <Pressable style={styles.settingsOutlineButton} onPress={onCreate} disabled={busy} accessibilityRole="button">
                <Text style={styles.settingsOutlineText}>ADD PROFILE</Text>
              </Pressable>
            </View>

            <View style={styles.settingsDangerZone}>
              <Text style={styles.settingsDangerTitle}>REMOVE CURRENT PROFILE</Text>
              <Text style={styles.settingsDangerCopy}>This removes only the local SQLite record from this device.</Text>
              <Pressable style={styles.settingsDeleteButton} onPress={onDelete} disabled={busy} accessibilityRole="button">
                <Text style={styles.settingsDeleteText}>DELETE PROFILE</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.currentProfileCard}>
            <View style={styles.profileCardHeader}>
              <Text style={styles.currentProfileLabel}>CURRENT PROFILE</Text>
              <View style={styles.profileCardBleActions}>
                <View style={styles.profileCardBleStatus}>
                  <View style={[
                    styles.profileCardBleDot,
                    bleStatus.phase === "ready" && styles.bleStatusDotReady,
                    bleStatus.phase === "connected" && styles.bleStatusDotConnected,
                    bleStatus.phase === "error" && styles.bleStatusDotError,
                  ]} />
                  <Text style={styles.profileCardBleText} numberOfLines={1}>
                    {bleStatus.phase === "ready" ? "READY" : bleStatus.phase.replace("-", " ").toUpperCase()}
                  </Text>
                </View>
                <Pressable
                  style={styles.profileCardDebugButton}
                  onPress={() => setDebugOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Show BLE debug details"
                >
                  <Ionicons name="bug-outline" size={18} color="#0a8c87" />
                </Pressable>
              </View>
            </View>
            <Text style={styles.currentProfileName}>{currentProfile.name}</Text>
            <Text style={styles.settingsMuted}>
              {currentProfile.country} · {currentProfile.halowChannel === 0 ? "Auto channel" : `Channel ${currentProfile.halowChannel}`}
            </Text>
            <Text style={styles.settingsMuted}>{currentProfile.location}</Text>
            <Text style={styles.settingsMuted}>User: {currentProfile.identityName}</Text>
            <Text style={styles.settingsMuted}>Identity: {currentProfile.identityId}</Text>
            <Text style={styles.settingsMuted}>Mesh ID: {currentProfile.meshId}</Text>
            <Text style={styles.settingsMuted}>
              BLE device: {currentProfile.bleDeviceName || currentProfile.bleDeviceId || "Not selected"}
            </Text>
            <Pressable style={styles.manageProfilesButton} onPress={onManage} disabled={busy} accessibilityRole="button">
              <Text style={styles.settingsOutlineText}>MANAGE PROFILES</Text>
            </Pressable>
          </View>
        )}
        {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      </ScrollView>
      <BleDebugModal
        visible={debugOpen}
        status={bleStatus}
        onClose={() => setDebugOpen(false)}
      />
    </SafeAreaView>
  );
}

