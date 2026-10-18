import Ionicons from "@expo/vector-icons/Ionicons";
import { EdgezOrganicMap, edgezBleDeviceLabel, useEdgezMeshSession } from "@edgez/react-native-sdk";
import type { EdgezBleDevice, EdgezOrganicMapRef } from "@edgez/react-native-sdk";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { styles } from "./app-styles";
import { bandwidthForChannel, bandwidthsForCountry, channelsForCountry, halowCountries } from "./halowChannels";
import { coordinatesFromLocation } from "./mesh-utils";
import { createProfileIdentity } from "./profile-store";
import type { ProfileDetails, StoredProfile } from "./profile-store";
import type { SharedProfileSettings } from "./app-settings";

type ProfileDraft = Omit<ProfileDetails, "halowChannel"> & { halowChannel: string; halowBandwidthMHz: string };

const countryMapCenters: Record<string, { latitude: number; longitude: number }> = {
  AU: { latitude: -25.2744, longitude: 133.7751 },
  CA: { latitude: 56.1304, longitude: -106.3468 },
  EU: { latitude: 50.8503, longitude: 4.3517 },
  GB: { latitude: 54, longitude: -2 },
  IN: { latitude: 20.5937, longitude: 78.9629 },
  JP: { latitude: 36.2048, longitude: 138.2529 },
  KR: { latitude: 35.9078, longitude: 127.7669 },
  NZ: { latitude: -40.9006, longitude: 174.886 },
  US: { latitude: 39.8283, longitude: -98.5795 },
};

type LegacyProfileDetails = Omit<ProfileDetails,
  "identityName" | "identityId" | "identityPrivateKey" | "identityPublicKey" |
  "bleDeviceId" | "bleDeviceName" | "connectToCloud"
>;

export function validProfileDetails(value: unknown): value is LegacyProfileDetails {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<LegacyProfileDetails>;
  return typeof profile.name === "string" && Boolean(profile.name.trim()) &&
    typeof profile.country === "string" && halowCountries.some(({ code }) => code === profile.country) &&
    typeof profile.location === "string" && Boolean(coordinatesFromLocation(profile.location)) &&
    typeof profile.halowChannel === "number" &&
    (profile.halowChannel === 0 || channelsForCountry(profile.country).some(({ number }) => number === profile.halowChannel)) &&
    typeof profile.meshId === "string" && Boolean(profile.meshId.trim()) && profile.meshId.trim().length <= 32 &&
    typeof profile.meshPassphrase === "string" &&
    (profile.meshPassphrase.length === 0 || (profile.meshPassphrase.length >= 8 && profile.meshPassphrase.length <= 63));
}

export function ProfileBleDevicePicker({
  selectedDeviceId,
  onCancel,
  onSelect,
  onClear,
}: {
  selectedDeviceId: string;
  onCancel: () => void;
  onSelect: (device: EdgezBleDevice) => void;
  onClear: () => void;
}) {
  const [session, state] = useEdgezMeshSession();
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanActive, setScanActive] = useState(false);
  const scanInFlight = useRef(false);
  const scanActiveRef = useRef(false);

  const scan = async () => {
    if (scanInFlight.current || scanActiveRef.current) return;
    scanInFlight.current = true;
    setScanning(true);
    setError("");
    try {
      await session.startBleScan();
      scanActiveRef.current = true;
      setScanActive(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not scan for BLE devices.");
    } finally {
      scanInFlight.current = false;
      setScanning(false);
    }
  };

  useEffect(() => {
    // Delay automatic scanning by one tick so React's development-only effect
    // replay does not start/stop Android BLE scans in rapid succession.
    const timer = setTimeout(() => { void scan(); }, 250);
    return () => {
      clearTimeout(timer);
      scanInFlight.current = false;
      scanActiveRef.current = false;
      void session.stopBleScan().catch(() => undefined);
    };
  }, [session]);

  const close = async () => {
    await session.stopBleScan().catch(() => undefined);
    scanActiveRef.current = false;
    setScanActive(false);
    onCancel();
  };

  const select = async (device: EdgezBleDevice) => {
    await session.stopBleScan().catch(() => undefined);
    scanActiveRef.current = false;
    setScanActive(false);
    onSelect(device);
  };

  const clear = async () => {
    await session.stopBleScan().catch(() => undefined);
    scanActiveRef.current = false;
    setScanActive(false);
    onClear();
  };

  const devices = [...state.bleDevices.values()].sort((left, right) => right.rssi - left.rssi);

  return (
    <SafeAreaView style={styles.bleSelectionPage}>
      <StatusBar style="dark" />
      <View style={styles.settingsHeader}>
        <View>
          <Text style={styles.settingsEyebrow}>PROFILE DEVICE</Text>
          <Text style={styles.settingsTitle}>Select BLE device</Text>
        </View>
        <Pressable style={styles.headerTextButton} onPress={() => void close()} hitSlop={8} accessibilityRole="button">
          <Text style={styles.settingsClose}>BACK</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.bleSelectionContent}>
        <Text style={styles.provisioningHelp}>Select the nearby EdgeZ device assigned to this profile.</Text>
        {selectedDeviceId ? (
          <Pressable
            style={styles.bleClearSelectionButton}
            onPress={() => void clear()}
            accessibilityRole="button"
            accessibilityLabel="Clear selected BLE device"
          >
            <Ionicons name="close-circle-outline" size={19} color="#b9472f" />
            <Text style={styles.bleClearSelectionText}>CLEAR SELECTED DEVICE</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={[styles.provisioningPrimary, (scanning || scanActive) && styles.disabledButton]}
          onPress={() => void scan()}
          disabled={scanning || scanActive}
          accessibilityRole="button"
        >
          {scanning
            ? <ActivityIndicator color="white" />
            : <Text style={styles.provisioningPrimaryText}>{scanActive ? "SCANNING…" : "START SCAN"}</Text>}
        </Pressable>
        <Text style={styles.provisioningStatus}>{state.statusLine}</Text>
        {error ? <Text style={styles.provisioningError}>{error}</Text> : null}
        {!devices.length && !error ? (
          <Text style={styles.settingsMuted}>Nearby EdgeZ BLE devices will appear here.</Text>
        ) : devices.map((device) => {
          const selected = device.id === selectedDeviceId;
          return (
            <Pressable
              key={device.id}
              style={[styles.bleDeviceRow, selected && styles.bleDeviceRowSelected]}
              onPress={() => void select(device)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <View style={styles.profileRowBody}>
                <Text style={styles.profileRowName}>{edgezBleDeviceLabel(device)}</Text>
                <Text style={styles.settingsMuted}>{device.id} · RSSI {device.rssi}</Text>
              </View>
              <Text style={[styles.profileRowStatus, selected && styles.profileRowStatusSelected]}>
                {selected ? "SELECTED" : "SELECT"}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

export function ProfileLocationPicker({
  location,
  country,
  subject = "profile",
  onCancel,
  onSelect,
}: {
  location: string;
  country: string;
  subject?: "profile" | "device";
  onCancel: () => void;
  onSelect: (location: string) => void;
}) {
  const map = useRef<EdgezOrganicMapRef>(null);
  const initial = coordinatesFromLocation(location) ?? countryMapCenters[country] ?? { latitude: 59.3293, longitude: 18.0686 };
  const [center, setCenter] = useState(initial);
  const [region, setRegion] = useState("");
  const [mapError, setMapError] = useState("");

  return (
    <SafeAreaView style={styles.locationPage}>
      <StatusBar style="dark" />
      <View style={styles.locationHeader}>
        <View>
          <Text style={styles.locationEyebrow}>{subject.toUpperCase()} LOCATION</Text>
          <Text style={styles.locationTitle}>Choose on map</Text>
        </View>
        <Pressable style={styles.headerTextButton} onPress={onCancel} hitSlop={8} accessibilityRole="button"><Text style={styles.locationClose}>BACK</Text></Pressable>
      </View>
      <View style={styles.locationMap}>
        <EdgezOrganicMap
          ref={map}
          nodes={[]}
          centerLatitude={initial.latitude}
          centerLongitude={initial.longitude}
          zoom={9}
          enableMapDownloads
          style={styles.map}
          onMapReady={() => map.current?.getCamera()}
          onCameraChanged={({ latitude, longitude }) => setCenter({ latitude, longitude })}
          onMapRegionAvailable={setRegion}
          onMapError={setMapError}
        />
        <View pointerEvents="none" style={styles.mapCrosshair}><Text style={styles.mapCrosshairText}>＋</Text></View>
        {region ? (
          <View style={styles.mapPrompt}>
            <Text style={styles.mapPromptTitle}>Save {region} offline?</Text>
            <View style={styles.mapPromptActions}>
              <Pressable style={styles.mapDownloadButton} onPress={() => { map.current?.downloadRegion(region); setRegion(""); }}>
                <Text style={styles.mapDownloadText}>DOWNLOAD</Text>
              </Pressable>
              <Pressable style={styles.mapLaterButton} onPress={() => { map.current?.dismissDownloadRegion(region); setRegion(""); }}>
                <Text style={styles.mapLaterText}>NOT NOW</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {mapError ? <View style={[styles.mapNotice, styles.mapError]}><Text style={styles.mapNoticeText}>{mapError}</Text></View> : null}
      </View>
      <View style={styles.locationFooter}>
        <Text style={styles.locationHelp}>Pan until the crosshair marks the {subject === "profile" ? "center of this profile" : "device position"}.</Text>
        <Text style={styles.locationCoordinates}>{center.latitude.toFixed(6)}, {center.longitude.toFixed(6)}</Text>
        <Pressable style={styles.locationUseButton} onPress={() => onSelect(`${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)}`)}>
          <Text style={styles.profileSaveText}>USE THIS LOCATION</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export function ProfileForm({
  initialProfile,
  sharedSettings,
  required,
  onCancel,
  onSave,
}: {
  initialProfile?: ProfileDetails;
  sharedSettings?: SharedProfileSettings;
  required: boolean;
  onCancel?: () => void;
  onSave: (profile: ProfileDetails) => Promise<void>;
}) {
  const creating = !initialProfile;
  const [draft, setDraft] = useState<ProfileDraft>(() => {
    if (!initialProfile) {
      return {
        name: "",
        ...(sharedSettings ?? { ...createProfileIdentity(), location: "", bleDeviceId: "", bleDeviceName: "" }),
        country: "US",
        halowChannel: "27",
        halowBandwidthMHz: "1",
        meshId: "",
        meshPassphrase: "",
        connectToCloud: false,
      };
    }
    const initialChannel = channelsForCountry(initialProfile.country)
      .find(({ number }) => number === initialProfile.halowChannel);
    return {
      ...initialProfile,
      halowChannel: String(initialProfile.halowChannel),
      halowBandwidthMHz: String(initialChannel ? bandwidthForChannel(initialChannel) : 1),
    };
  });
  const [meshIdEdited, setMeshIdEdited] = useState(Boolean(initialProfile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [openDropdown, setOpenDropdown] = useState<"country" | "bandwidth" | "channel" | null>(null);
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const set = (key: keyof ProfileDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const selectedCountry = halowCountries.find(({ code }) => code === draft.country);
  const availableBandwidths = bandwidthsForCountry(draft.country);
  const selectedBandwidth = Number(draft.halowBandwidthMHz);
  const availableChannels = channelsForCountry(draft.country)
    .filter((channel) => bandwidthForChannel(channel) === selectedBandwidth);
  const selectedChannel = availableChannels.find(({ number }) => String(number) === draft.halowChannel);

  const save = async () => {
    const country = draft.country.trim().toUpperCase();
    const channel = Number(draft.halowChannel);
    if (!draft.name.trim() ||
      !halowCountries.some(({ code }) => code === country) ||
      !bandwidthsForCountry(country).includes(selectedBandwidth) ||
      !draft.halowChannel.trim() || (channel !== 0 && !availableChannels.some(({ number }) => number === channel)) ||
      !draft.meshId.trim() || draft.meshId.trim().length > 32 ||
      (draft.meshPassphrase.length > 0 && (draft.meshPassphrase.length < 8 || draft.meshPassphrase.length > 63))) {
      setError("Enter the required fields, choose a valid country, bandwidth and frequency, and leave the passphrase empty or use 8–63 characters.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: draft.name.trim(),
        identityName: draft.identityName.trim(),
        identityId: draft.identityId,
        identityPrivateKey: draft.identityPrivateKey,
        identityPublicKey: draft.identityPublicKey,
        country,
        location: draft.location.trim(),
        halowChannel: channel,
        meshId: draft.meshId.trim(),
        meshPassphrase: draft.meshPassphrase,
        connectToCloud: draft.connectToCloud,
        bleDeviceId: draft.bleDeviceId,
        bleDeviceName: draft.bleDeviceName,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.profilePage}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.profileContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.profileEyebrow}>OFFGRID TRACKER</Text>
        <Text style={styles.profileTitle}>{required ? "Create your profile" : creating ? "Create profile" : "Edit profile"}</Text>
        <Text style={styles.profileDescription}>
          Configure the HaLow radio profile used by devices on this mesh.
        </Text>
        <Text style={styles.fieldLabel}>PROFILE NAME</Text>
        <TextInput
          style={styles.profileInput}
          value={draft.name}
          onChangeText={(value) => setDraft((current) => ({
            ...current,
            name: value,
            meshId: meshIdEdited ? current.meshId : value.slice(0, 32),
          }))}
          placeholder="For example, North pasture"
          placeholderTextColor="#718a83"
          autoCapitalize="words"
          autoCorrect={false}
          accessibilityLabel="Profile name"
        />
        <Text style={styles.fieldLabel}>COUNTRY</Text>
        <Pressable
          style={styles.profileSelect}
          onPress={() => setOpenDropdown((current) => current === "country" ? null : "country")}
          accessibilityRole="button"
          accessibilityState={{ expanded: openDropdown === "country" }}
        >
          <Text style={selectedCountry ? styles.profileSelectText : styles.profileSelectPlaceholder}>
            {selectedCountry ? `${selectedCountry.name} (${selectedCountry.code})` : "Choose country"}
          </Text>
          <Text style={styles.profileSelectText}>⌄</Text>
        </Pressable>
        {openDropdown === "country" ? (
          <ScrollView style={styles.profileOptionList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {halowCountries.map((country) => (
              <Pressable
                key={country.code}
                style={[styles.profileOption, draft.country === country.code && styles.profileOptionSelected]}
                onPress={() => {
                  const bandwidth = bandwidthsForCountry(country.code)[0] ?? 1;
                  setDraft((current) => ({ ...current, country: country.code, halowBandwidthMHz: String(bandwidth), halowChannel: "0" }));
                  setOpenDropdown(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.country === country.code }}
              >
                <Text style={[styles.profileOptionText, draft.country === country.code && styles.profileOptionTextSelected]}>
                  {country.name} ({country.code})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <Text style={styles.fieldLabel}>BANDWIDTH</Text>
        <Pressable
          style={[styles.profileSelect, !draft.country && styles.disabledButton]}
          onPress={() => draft.country && setOpenDropdown((current) => current === "bandwidth" ? null : "bandwidth")}
          disabled={!draft.country}
          accessibilityRole="button"
          accessibilityState={{ expanded: openDropdown === "bandwidth", disabled: !draft.country }}
        >
          <Text style={draft.country ? styles.profileSelectText : styles.profileSelectPlaceholder}>
            {draft.country ? `${draft.halowBandwidthMHz} MHz` : "Choose country first"}
          </Text>
          <Text style={styles.profileSelectText}>⌄</Text>
        </Pressable>
        {openDropdown === "bandwidth" ? (
          <View style={styles.profileOptionList}>
            {availableBandwidths.map((bandwidth) => (
              <Pressable
                key={bandwidth}
                style={[styles.profileOption, selectedBandwidth === bandwidth && styles.profileOptionSelected]}
                onPress={() => {
                  setDraft((current) => ({ ...current, halowBandwidthMHz: String(bandwidth), halowChannel: "0" }));
                  setOpenDropdown(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: selectedBandwidth === bandwidth }}
              >
                <Text style={[styles.profileOptionText, selectedBandwidth === bandwidth && styles.profileOptionTextSelected]}>
                  {bandwidth} MHz
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Text style={styles.fieldLabel}>FREQUENCY</Text>
        <Pressable
          style={[styles.profileSelect, !draft.country && styles.disabledButton]}
          onPress={() => draft.country && setOpenDropdown((current) => current === "channel" ? null : "channel")}
          disabled={!draft.country}
          accessibilityRole="button"
          accessibilityState={{ expanded: openDropdown === "channel", disabled: !draft.country }}
        >
          <Text style={draft.country ? styles.profileSelectText : styles.profileSelectPlaceholder}>
            {!draft.country
              ? "Choose country first"
              : draft.halowChannel === "0"
                ? "Auto"
                : selectedChannel
                  ? `${selectedChannel.frequencyMHz} MHz · Channel ${selectedChannel.number}`
                  : "Choose frequency"}
          </Text>
          <Text style={styles.profileSelectText}>⌄</Text>
        </Pressable>
        {openDropdown === "channel" ? (
          <ScrollView style={styles.profileOptionList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            <Pressable
              style={[styles.profileOption, draft.halowChannel === "0" && styles.profileOptionSelected]}
              onPress={() => { set("halowChannel", "0"); setOpenDropdown(null); }}
              accessibilityRole="radio"
              accessibilityState={{ selected: draft.halowChannel === "0" }}
            >
              <Text style={[styles.profileOptionText, draft.halowChannel === "0" && styles.profileOptionTextSelected]}>Auto</Text>
            </Pressable>
            {availableChannels.map((channel) => (
              <Pressable
                key={channel.number}
                style={[styles.profileOption, draft.halowChannel === String(channel.number) && styles.profileOptionSelected]}
                onPress={() => { set("halowChannel", String(channel.number)); setOpenDropdown(null); }}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.halowChannel === String(channel.number) }}
              >
                <Text style={[styles.profileOptionText, draft.halowChannel === String(channel.number) && styles.profileOptionTextSelected]}>
                  {channel.frequencyMHz} MHz · Channel {channel.number}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <Text style={styles.fieldLabel}>MESH ID</Text>
        <TextInput
          style={styles.profileInput}
          value={draft.meshId}
          onChangeText={(value) => {
            setMeshIdEdited(true);
            set("meshId", value);
          }}
          placeholder="Mesh ID"
          placeholderTextColor="#718a83"
          maxLength={32}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.fieldLabel}>MESH PASSPHRASE</Text>
        <View style={styles.passphraseField}>
          <TextInput
            style={styles.passphraseInput}
            value={draft.meshPassphrase}
            onChangeText={(value) => set("meshPassphrase", value)}
            placeholder="Optional · 8–63 characters"
            placeholderTextColor="#718a83"
            maxLength={63}
            secureTextEntry={!passphraseVisible}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Mesh passphrase"
          />
          <Pressable
            style={styles.passphraseVisibilityButton}
            onPress={() => setPassphraseVisible((visible) => !visible)}
            accessibilityRole="button"
            accessibilityLabel={`${passphraseVisible ? "Hide" : "Show"} mesh passphrase`}
            accessibilityState={{ checked: passphraseVisible }}
          >
            <Ionicons name={passphraseVisible ? "eye-outline" : "eye-off-outline"} size={24} color="#8cb0ad" />
          </Pressable>
        </View>
        <Pressable
          style={styles.profileCheckboxRow}
          onPress={() => setDraft((current) => ({ ...current, connectToCloud: !current.connectToCloud }))}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: draft.connectToCloud }}
          accessibilityLabel="Connect to cloud"
        >
          <Ionicons
            name={draft.connectToCloud ? "checkbox" : "square-outline"}
            size={24}
            color={draft.connectToCloud ? "#69cfc7" : "#90aaa7"}
          />
          <View style={styles.profileCheckboxBody}>
            <Text style={styles.profileCheckboxLabel}>CONNECT TO CLOUD</Text>
            <Text style={styles.profileCheckboxHelp}>Show online when this profile has an authenticated cloud session.</Text>
          </View>
        </Pressable>
        {error ? <Text style={styles.profileError}>{error}</Text> : null}
        <Pressable
          style={[styles.profileSaveButton, saving && styles.disabledButton]}
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
        >
          <Text style={styles.profileSaveText}>{saving ? "SAVING…" : creating ? "CREATE PROFILE" : "SAVE PROFILE"}</Text>
        </Pressable>
        {!required && onCancel ? (
          <Pressable style={styles.profileCancelButton} onPress={onCancel} disabled={saving} accessibilityRole="button">
            <Text style={styles.profileCancelText}>CANCEL</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
