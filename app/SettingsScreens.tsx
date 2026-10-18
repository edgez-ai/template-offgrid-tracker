import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { BleLinkStatus } from "./ActiveProfileBleLink";
import { styles } from "./app-styles";
import { ProfileBleDevicePicker, ProfileLocationPicker } from "./ProfileScreens";
import type { LocationMode, SharedProfileSettings } from "./app-settings";
import type { StoredProfile } from "./profile-store";
import { bandwidthForChannel, channelsForCountry } from "./halowChannels";
import { beaconColorValues, beaconIconColors, beaconIconLabels, beaconIconNames, beaconIconTypes } from "./beacon-options";
import type { BeaconIconColor, BeaconIconType } from "./beacon-options";

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
            <Pressable style={styles.headerTextButton} onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close BLE debug">
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
  sharedSettings,
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
  onSaveSharedSettings,
}: {
  profiles: StoredProfile[];
  currentProfile: StoredProfile;
  sharedSettings: SharedProfileSettings;
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
  onSaveSharedSettings: (settings: SharedProfileSettings) => Promise<void>;
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [blePickerOpen, setBlePickerOpen] = useState(false);
  const [identityName, setIdentityName] = useState(sharedSettings.identityName);
  const [iconType, setIconType] = useState<BeaconIconType>(sharedSettings.iconType);
  const [iconColor, setIconColor] = useState<BeaconIconColor>(sharedSettings.iconColor);
  const [locationMode, setLocationMode] = useState<LocationMode>(sharedSettings.locationMode);
  const [location, setLocation] = useState(sharedSettings.location);
  const [bleDeviceId, setBleDeviceId] = useState(sharedSettings.bleDeviceId);
  const [bleDeviceName, setBleDeviceName] = useState(sharedSettings.bleDeviceName);
  const [savingSharedSettings, setSavingSharedSettings] = useState(false);
  const [sharedSettingsError, setSharedSettingsError] = useState("");
  const selectedChannel = channelsForCountry(currentProfile.country)
    .find(({ number }) => number === currentProfile.halowChannel);

  useEffect(() => {
    setIdentityName(sharedSettings.identityName);
    setIconType(sharedSettings.iconType);
    setIconColor(sharedSettings.iconColor);
    setLocationMode(sharedSettings.locationMode);
    setLocation(sharedSettings.location);
    setBleDeviceId(sharedSettings.bleDeviceId);
    setBleDeviceName(sharedSettings.bleDeviceName);
  }, [sharedSettings]);

  const saveSharedSettings = async () => {
    if (!identityName.trim()) {
      setSharedSettingsError("Enter the name shown to other mesh users.");
      return;
    }
    if (locationMode === "fixed" && !location) {
      setSharedSettingsError("Choose the fixed location on the map.");
      return;
    }
    setSavingSharedSettings(true);
    setSharedSettingsError("");
    try {
      await onSaveSharedSettings({
        identityName: identityName.trim(),
        identityId: sharedSettings.identityId,
        identityPrivateKey: sharedSettings.identityPrivateKey,
        identityPublicKey: sharedSettings.identityPublicKey,
        iconType,
        iconColor,
        locationMode,
        location,
        bleDeviceId,
        bleDeviceName,
      });
    } catch (caught) {
      setSharedSettingsError(caught instanceof Error ? caught.message : "Could not save app settings.");
    } finally {
      setSavingSharedSettings(false);
    }
  };

  return (
    <SafeAreaView style={styles.settingsPage}>
      <StatusBar style="dark" />
      <View style={styles.settingsHeader}>
        <View>
          <Text style={styles.settingsEyebrow}>SETTINGS</Text>
          <Text style={styles.settingsTitle}>{managerOpen ? "Profile management" : "Profile settings"}</Text>
        </View>
        <Pressable style={styles.headerTextButton} onPress={managerOpen ? onBack : onClose} disabled={busy} hitSlop={8} accessibilityRole="button">
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
              {currentProfile.country} · {selectedChannel ? `${bandwidthForChannel(selectedChannel)} MHz · ${selectedChannel.frequencyMHz} MHz` : "Auto frequency"}
            </Text>
            <Text style={styles.settingsMuted}>Mesh ID: {currentProfile.meshId}</Text>
            <Pressable style={styles.manageProfilesButton} onPress={onManage} disabled={busy} accessibilityRole="button">
              <Text style={styles.settingsOutlineText}>MANAGE PROFILES</Text>
            </Pressable>
          </View>
        )}
        {!managerOpen ? (
          <>
            <Text style={styles.settingsSectionLabel}>SHARED APP SETTINGS</Text>
            <View style={styles.sharedSettingsCard}>
              <Text style={styles.settingsFieldLabel}>USER NAME</Text>
              <TextInput
                style={styles.settingsInput}
                value={identityName}
                onChangeText={setIdentityName}
                placeholder="Name shown to mesh peers"
                placeholderTextColor="#718783"
                maxLength={64}
                autoCapitalize="words"
                autoCorrect={false}
              />
              <Text style={styles.settingsFieldLabel}>ICON TYPE</Text>
              <View style={styles.beaconIconOptions} accessibilityRole="radiogroup">
                {beaconIconTypes.map((type) => {
                  const selected = iconType === type;
                  return (
                    <Pressable
                      key={type}
                      style={[styles.beaconIconOption, selected && styles.beaconIconOptionSelected]}
                      onPress={() => setIconType(type)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={beaconIconLabels[type]}
                    >
                      <View style={[styles.beaconIconGlyph, selected && { backgroundColor: `${beaconColorValues[iconColor]}22` }]}>
                        <MaterialCommunityIcons name={beaconIconNames[type]} size={24} color={selected ? beaconColorValues[iconColor] : "#59716f"} />
                      </View>
                      {selected ? (
                        <View style={styles.beaconIconCheck}>
                          <Ionicons name="checkmark" size={10} color="white" />
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.settingsFieldLabel}>ICON COLOR</Text>
              <View style={styles.beaconColorOptions} accessibilityRole="radiogroup">
                {beaconIconColors.map((color) => (
                  <Pressable
                    key={color}
                    style={[styles.beaconColorOption, iconColor === color && styles.beaconColorOptionSelected]}
                    onPress={() => setIconColor(color)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: iconColor === color }}
                    accessibilityLabel={color}
                  >
                    <View style={[styles.beaconColorSwatch, { backgroundColor: beaconColorValues[color] }]} />
                  </Pressable>
                ))}
              </View>
              <Text style={styles.settingsFieldLabel}>IDENTITY ID</Text>
              <View style={styles.settingsReadOnlyField}>
                <Text style={styles.settingsReadOnlyText} selectable>{sharedSettings.identityId}</Text>
              </View>
              <Text style={styles.settingsFieldLabel}>LOCATION</Text>
              <View style={styles.locationModeRow} accessibilityRole="radiogroup">
                {(["off", "fixed", "live"] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    style={[styles.locationModeOption, locationMode === mode && styles.locationModeOptionSelected]}
                    onPress={() => setLocationMode(mode)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: locationMode === mode }}
                  >
                    <Text style={[styles.locationModeText, locationMode === mode && styles.locationModeTextSelected]}>
                      {mode === "off" ? "Off" : mode === "fixed" ? "Map" : "Live"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {locationMode === "fixed" ? (
                <Pressable style={styles.settingsSelect} onPress={() => setLocationPickerOpen(true)} accessibilityRole="button">
                  <Text style={location ? styles.settingsSelectText : styles.settingsSelectPlaceholder}>
                    {location || "Choose on offline map"}
                  </Text>
                  <Ionicons name="location-outline" size={21} color="#0a8c87" />
                </Pressable>
              ) : locationMode === "live" ? (
                <Text style={styles.settingsInlineHelp}>Uses the phone’s current location while the app is connected to the device.</Text>
              ) : (
                <Text style={styles.settingsInlineHelp}>Location is not included in mesh beacons.</Text>
              )}
              <Text style={styles.settingsFieldLabel}>BLE DEVICE</Text>
              <Pressable style={styles.settingsSelect} onPress={() => setBlePickerOpen(true)} accessibilityRole="button">
                <View style={styles.profileSelectedDeviceText}>
                  <Text style={bleDeviceId ? styles.settingsSelectText : styles.settingsSelectPlaceholder}>
                    {bleDeviceName || bleDeviceId || "Select nearby device"}
                  </Text>
                  {bleDeviceId ? <Text style={styles.profileSelectedDeviceId}>{bleDeviceId}</Text> : null}
                </View>
                <Ionicons name="bluetooth-outline" size={22} color="#0a8c87" />
              </Pressable>
              {bleDeviceId ? (
                <Pressable
                  style={styles.profileClearDeviceButton}
                  onPress={() => { setBleDeviceId(""); setBleDeviceName(""); }}
                  accessibilityRole="button"
                >
                  <Text style={styles.profileClearDeviceText}>REMOVE SELECTED DEVICE</Text>
                </Pressable>
              ) : null}
              {sharedSettingsError ? <Text style={styles.settingsError}>{sharedSettingsError}</Text> : null}
              <Pressable
                style={[styles.settingsPrimaryButton, savingSharedSettings && styles.disabledButton]}
                onPress={() => void saveSharedSettings()}
                disabled={savingSharedSettings}
                accessibilityRole="button"
              >
                {savingSharedSettings
                  ? <ActivityIndicator color="white" />
                  : <Text style={styles.settingsPrimaryText}>SAVE APP SETTINGS</Text>}
              </Pressable>
              <Text style={styles.settingsSharedHelp}>These settings apply to every profile on this phone.</Text>
            </View>
          </>
        ) : null}
        {error ? <Text style={styles.settingsError}>{error}</Text> : null}
      </ScrollView>
      <BleDebugModal
        visible={debugOpen}
        status={bleStatus}
        onClose={() => setDebugOpen(false)}
      />
      <Modal visible={locationPickerOpen} animationType="slide" onRequestClose={() => setLocationPickerOpen(false)}>
        <ProfileLocationPicker
          location={location}
          country={currentProfile.country}
          subject="profile"
          onCancel={() => setLocationPickerOpen(false)}
          onSelect={(nextLocation) => { setLocation(nextLocation); setLocationPickerOpen(false); }}
        />
      </Modal>
      {blePickerOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setBlePickerOpen(false)}>
          <ProfileBleDevicePicker
            selectedDeviceId={bleDeviceId}
            onCancel={() => setBlePickerOpen(false)}
            onSelect={(device) => {
              setBleDeviceId(device.id);
              setBleDeviceName(device.name);
              setBlePickerOpen(false);
            }}
            onClear={() => {
              setBleDeviceId("");
              setBleDeviceName("");
              setBlePickerOpen(false);
            }}
          />
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}
