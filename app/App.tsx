import "react-native-get-random-values";
import { EdgezOrganicMap, EdgezProvisioningManager, edgezBleDeviceLabel, useEdgezMeshSession } from "@edgez/react-native-sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { EdgezBleDevice, EdgezMapDownloadUpdate, EdgezMeshSession, EdgezOrganicMapRef, EdgezProvisioningDevice, EdgezProvisioningInput } from "@edgez/react-native-sdk";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { bandwidthForChannel, bandwidthsForCountry, channelsForCountry, halowCountries } from "./halowChannels";
import {
  activeProfile,
  createProfileIdentity,
  createProfile,
  deleteProfile,
  initializeProfileStore,
  listProfileDevices,
  listProfiles,
  profileDeviceUuid,
  profileIdentity,
  saveProfileDevice,
  setActiveProfile,
  updateProfile,
} from "./profile-store";
import type { ProfileDetails, StoredDevice, StoredProfile } from "./profile-store";

type ProfileDraft = Omit<ProfileDetails, "halowChannel"> & { halowChannel: string; halowBandwidthMHz: string };
type DeviceLocationChoice = "none" | "current" | "map" | "gps";

const profileStorageKey = "offgrid-tracker.profile.v1";
const provisioningPop = "abcd1234";
const provisioningManager = new EdgezProvisioningManager();
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

function coordinatesFromLocation(location: string) {
  const match = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

type BleLinkStatus = {
  phase: "not-selected" | "preparing" | "disconnected" | "connecting" | "connected" | "ready" | "error";
  label: string;
  details: string[];
  halowLinkUp: boolean | null;
  updatedAt: number;
};

function ActiveProfileBleLink({
  profile,
  onStatusChange,
}: {
  profile: StoredProfile;
  onStatusChange: (status: BleLinkStatus) => void;
}) {
  const sessionRef = useRef<EdgezMeshSession | null>(null);
  const retryDelayMs = useRef(500);
  const [configured, setConfigured] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [session, state] = useEdgezMeshSession({
    onIncomingMessage: (message, sender) => {
      void sessionRef.current?.sdk.showIncomingMessageNotification(message, sender).catch(() => undefined);
    },
  });
  sessionRef.current = session;

  useEffect(() => {
    let cancelled = false;
    setConfigured(false);
    setSetupError("");
    void (async () => {
      if (!profile.bleDeviceId) return;
      const channel = channelsForCountry(profile.country).find(({ number }) => number === profile.halowChannel);
      const coordinates = coordinatesFromLocation(profile.location);
      await session.initializeMesh({
        identity: profileIdentity(profile),
        countryCode: profile.country,
        meshId: profile.meshId,
        passphrase: profile.meshPassphrase,
        meshBandwidthMhz: channel ? bandwidthForChannel(channel) : 0,
        meshFrequencyKhz: channel ? Math.round(channel.frequencyMHz * 1000) : 0,
        beacon: {
          shareLocation: Boolean(coordinates),
          latitude: coordinates?.latitude,
          longitude: coordinates?.longitude,
        },
      });
      await session.sdk.requestNotificationPermission().catch(() => false);
      if (!cancelled) setConfigured(true);
    })().catch((caught) => {
      if (!cancelled) {
        setConfigured(false);
        setSetupError(caught instanceof Error ? caught.message : "BLE setup failed");
      }
    });
    return () => {
      cancelled = true;
      void session.disconnect().catch(() => undefined);
    };
  }, [profile, session]);

  useEffect(() => {
    if (state.connection !== "none") {
      retryDelayMs.current = 500;
      return;
    }
    if (!configured || !profile.bleDeviceId || state.bleConnecting) return;
    const delay = retryDelayMs.current;
    const retry = setTimeout(() => {
      void session.connectBle(profile.bleDeviceId).catch(() => {
        retryDelayMs.current = Math.min(delay * 2, 30_000);
      });
    }, delay);
    return () => clearTimeout(retry);
  }, [configured, profile.bleDeviceId, session, state.bleConnecting, state.connection]);

  useEffect(() => {
    const details = [
      `Device: ${profile.bleDeviceName || profile.bleDeviceId || "Not selected"}`,
      `Device ID: ${profile.bleDeviceId || "Not selected"}`,
      `Connection: ${state.connection}`,
      `Control channel: ${state.bleReady ? "ready" : "not ready"}`,
      `Connecting: ${state.bleConnecting ? "yes" : "no"}`,
      `Session: ${state.statusLine}`,
      ...(state.status ? [
        `Firmware: ${state.status.firmwareVersion || "unknown"}`,
        `License: ${state.status.licenseStatus}`,
        `HaLow stack: ${state.status.stackInitialized ? "initialized" : "not initialized"}`,
        `HaLow link: ${state.status.linkUp ? "up" : "down"}`,
        `Route: ${state.status.routeReady ? "ready" : "not ready"}`,
        `Mesh ID: ${state.status.meshId || "unknown"}`,
        `MAC: ${state.status.macAddress ? state.status.macAddress.toString(16).padStart(12, "0").toUpperCase() : "unknown"}`,
      ] : ["Device status: waiting"]),
    ];
    const liveStatus = {
      details,
      halowLinkUp: state.status ? state.status.linkUp : null,
      updatedAt: Date.now(),
    };
    if (!profile.bleDeviceId) {
      onStatusChange({ phase: "not-selected", label: "No BLE device selected", ...liveStatus });
    } else if (setupError) {
      onStatusChange({ phase: "error", label: setupError, ...liveStatus });
    } else if (!configured) {
      onStatusChange({ phase: "preparing", label: "Preparing BLE connection", ...liveStatus });
    } else if (state.bleReady) {
      onStatusChange({ phase: "ready", label: "BLE control channel ready", ...liveStatus });
    } else if (state.connection === "ble") {
      onStatusChange({ phase: "connected", label: "BLE connected", ...liveStatus });
    } else if (state.bleConnecting) {
      onStatusChange({ phase: "connecting", label: "Connecting to BLE device", ...liveStatus });
    } else {
      onStatusChange({ phase: "disconnected", label: "BLE disconnected · retrying", ...liveStatus });
    }
  }, [configured, onStatusChange, profile.bleDeviceId, profile.bleDeviceName, setupError, state.bleConnecting, state.bleReady, state.connection, state.status, state.statusLine]);

  return null;
}

type LegacyProfileDetails = Omit<ProfileDetails, "identityName" | "identityId" | "identityPrivateKey" | "identityPublicKey" | "bleDeviceId" | "bleDeviceName">;

function validProfileDetails(value: unknown): value is LegacyProfileDetails {
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

function ProfileBleDevicePicker({
  selectedDeviceId,
  onCancel,
  onSelect,
}: {
  selectedDeviceId: string;
  onCancel: () => void;
  onSelect: (device: EdgezBleDevice) => void;
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

  const devices = [...state.bleDevices.values()].sort((left, right) => right.rssi - left.rssi);

  return (
    <SafeAreaView style={styles.bleSelectionPage}>
      <StatusBar style="dark" />
      <View style={styles.settingsHeader}>
        <View>
          <Text style={styles.settingsEyebrow}>PROFILE DEVICE</Text>
          <Text style={styles.settingsTitle}>Select BLE device</Text>
        </View>
        <Pressable onPress={() => void close()} accessibilityRole="button">
          <Text style={styles.settingsClose}>BACK</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.bleSelectionContent}>
        <Text style={styles.provisioningHelp}>Select the nearby EdgeZ device assigned to this profile.</Text>
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

function ProfileLocationPicker({
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
        <Pressable onPress={onCancel} accessibilityRole="button"><Text style={styles.locationClose}>BACK</Text></Pressable>
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

function ProfileForm({
  initialProfile,
  required,
  onCancel,
  onSave,
}: {
  initialProfile?: ProfileDetails;
  required: boolean;
  onCancel?: () => void;
  onSave: (profile: ProfileDetails) => Promise<void>;
}) {
  const creating = !initialProfile;
  const [draft, setDraft] = useState<ProfileDraft>(() => {
    if (!initialProfile) {
      return { name: "", ...createProfileIdentity(), country: "US", location: "", halowChannel: "27", halowBandwidthMHz: "1", meshId: "", meshPassphrase: "", bleDeviceId: "", bleDeviceName: "" };
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
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [blePickerOpen, setBlePickerOpen] = useState(false);
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
    if (!draft.name.trim() || !draft.identityName.trim() || !draft.identityId.trim() || !coordinatesFromLocation(draft.location) ||
      !halowCountries.some(({ code }) => code === country) ||
      !bandwidthsForCountry(country).includes(selectedBandwidth) ||
      !draft.halowChannel.trim() || (channel !== 0 && !availableChannels.some(({ number }) => number === channel)) ||
      !draft.meshId.trim() || draft.meshId.trim().length > 32 ||
      (draft.meshPassphrase.length > 0 && (draft.meshPassphrase.length < 8 || draft.meshPassphrase.length > 63))) {
      setError("Enter the required fields, choose a valid location and country, use Auto or an allowed HaLow channel, and leave the passphrase empty or use 8–63 characters.");
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
          This local profile contains the location and radio settings used when provisioning devices.
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
        <Text style={styles.fieldLabel}>USER NAME</Text>
        <TextInput
          style={styles.profileInput}
          value={draft.identityName}
          onChangeText={(value) => set("identityName", value)}
          placeholder="Name shown to mesh peers"
          placeholderTextColor="#718a83"
          maxLength={64}
          autoCapitalize="words"
          autoCorrect={false}
          accessibilityLabel="Mesh user name"
        />
        <Text style={styles.fieldLabel}>IDENTITY ID</Text>
        <View style={styles.identityField}>
          <Text style={styles.identityValue} selectable>{draft.identityId}</Text>
        </View>
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
        <Text style={styles.fieldLabel}>LOCATION</Text>
        <Pressable
          style={styles.profileSelect}
          onPress={() => { setOpenDropdown(null); setLocationPickerOpen(true); }}
          accessibilityRole="button"
        >
          <Text style={draft.location ? styles.profileSelectText : styles.profileSelectPlaceholder}>{draft.location || "Choose on offline map"}</Text>
          <Text style={styles.profileSelectText}>⌖</Text>
        </Pressable>
        <Text style={styles.fieldLabel}>HALOW BANDWIDTH</Text>
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
        <Text style={styles.fieldLabel}>HALOW CHANNEL</Text>
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
                  ? `Channel ${selectedChannel.number} · ${selectedChannel.frequencyMHz} MHz`
                  : "Choose channel"}
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
                  Channel {channel.number} · {channel.frequencyMHz} MHz
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
        <Text style={styles.fieldLabel}>BLE DEVICE</Text>
        <Pressable
          style={styles.profileSelect}
          onPress={() => { setOpenDropdown(null); setBlePickerOpen(true); }}
          accessibilityRole="button"
        >
          <View style={styles.profileSelectedDeviceText}>
            <Text style={draft.bleDeviceId ? styles.profileSelectText : styles.profileSelectPlaceholder}>
              {draft.bleDeviceName || draft.bleDeviceId || "Select nearby device (optional)"}
            </Text>
            {draft.bleDeviceId ? <Text style={styles.profileSelectedDeviceId}>{draft.bleDeviceId}</Text> : null}
          </View>
          <Ionicons name="bluetooth-outline" size={22} color="#8cb0ad" />
        </Pressable>
        {draft.bleDeviceId ? (
          <Pressable
            style={styles.profileClearDeviceButton}
            onPress={() => setDraft((current) => ({ ...current, bleDeviceId: "", bleDeviceName: "" }))}
            accessibilityRole="button"
          >
            <Text style={styles.profileClearDeviceText}>REMOVE SELECTED DEVICE</Text>
          </Pressable>
        ) : null}
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
      <Modal visible={locationPickerOpen} animationType="slide" onRequestClose={() => setLocationPickerOpen(false)}>
        <ProfileLocationPicker
          location={draft.location}
          country={draft.country}
          onCancel={() => setLocationPickerOpen(false)}
          onSelect={(location) => { set("location", location); setLocationPickerOpen(false); }}
        />
      </Modal>
      {blePickerOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setBlePickerOpen(false)}>
          <ProfileBleDevicePicker
            selectedDeviceId={draft.bleDeviceId}
            onCancel={() => setBlePickerOpen(false)}
            onSelect={(device) => {
              setDraft((current) => ({ ...current, bleDeviceId: device.id, bleDeviceName: device.name }));
              setBlePickerOpen(false);
            }}
          />
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

function ProvisioningPasswordField({
  value,
  onChangeText,
  placeholder,
  accessibilityName,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityName: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={styles.provisioningPasswordField}>
      <TextInput
        style={styles.provisioningPasswordInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#829693"
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={63}
        accessibilityLabel={accessibilityName}
      />
      <Pressable
        style={styles.provisioningVisibilityButton}
        onPress={() => setVisible((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel={`${visible ? "Hide" : "Show"} ${accessibilityName}`}
        accessibilityState={{ checked: visible }}
      >
        <Ionicons name={visible ? "eye-outline" : "eye-off-outline"} size={23} color="#59716f" />
      </Pressable>
    </View>
  );
}

function ProvisioningFlow({
  profile,
  onClose,
  onProvisioned,
}: {
  profile: StoredProfile;
  onClose: () => void;
  onProvisioned: () => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [devices, setDevices] = useState<EdgezProvisioningDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<EdgezProvisioningDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Start by scanning for a device in provisioning mode.");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [proofOfPossession, setProofOfPossession] = useState(provisioningPop);
  const [deviceWifiPassword, setDeviceWifiPassword] = useState("");
  const [deviceLocationChoice, setDeviceLocationChoice] = useState<DeviceLocationChoice>("none");
  const [deviceLocation, setDeviceLocation] = useState("");
  const [deviceLocationLoading, setDeviceLocationLoading] = useState(false);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);

  const disconnect = async () => {
    if (selectedDevice) await provisioningManager.disconnect(selectedDevice);
    setConnected(false);
  };

  const close = () => {
    if (busy) return;
    void disconnect();
    onClose();
  };

  const scan = async () => {
    setBusy(true);
    setError("");
    setStatus("Scanning for ESP32, nRF54, and H7608 devices…");
    try {
      await disconnect();
      setSelectedDevice(null);
      const result = await provisioningManager.scan({ esp32BlePrefix: "EZ_" });
      setDevices(result.devices);
      setStatus(result.devices.length
        ? "Select a device to provision."
        : result.warnings[0] || "No provisioning devices were found.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Device scan failed.");
      setStatus("Scan did not complete.");
    } finally {
      setBusy(false);
    }
  };

  const selectDevice = (device: EdgezProvisioningDevice) => {
    if (selectedDevice) void provisioningManager.disconnect(selectedDevice);
    setSelectedDevice(device);
    setConnected(false);
    setName(device.requiresDeviceName ? device.serial : "");
    setProofOfPossession(provisioningPop);
    setDeviceWifiPassword("");
    setDeviceLocationChoice("none");
    setDeviceLocation("");
    setError("");
    setStatus(`Confirm the details for ${device.name}.`);
    setStep(2);
  };

  const chooseCurrentDeviceLocation = async () => {
    setDeviceLocationLoading(true);
    setError("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is needed to use the phone's position.");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setDeviceLocation(`${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`);
      setDeviceLocationChoice("current");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not determine the current location.");
    } finally {
      setDeviceLocationLoading(false);
    }
  };

  const connect = async () => {
    if (!selectedDevice) return;
    if (selectedDevice.requiresDeviceName && !name.trim()) {
      setError("Enter a device name.");
      return;
    }
    if (name.trim().length > selectedDevice.deviceNameMaxLength) {
      setError(`The device name must not exceed ${selectedDevice.deviceNameMaxLength} characters.`);
      return;
    }
    if (selectedDevice.requiresProofOfPossession && !proofOfPossession.trim()) {
      setError(selectedDevice.transport === "softap" ? "Enter the current device Wi-Fi password." : "Enter the proof of possession.");
      return;
    }
    if (selectedDevice.kind === "h7608" && !/^[\x20-\x7e]{8,63}$/.test(deviceWifiPassword)) {
      setError("The new device Wi-Fi password must contain 8–63 printable characters.");
      return;
    }
    if (deviceLocationChoice !== "none" && deviceLocationChoice !== "gps" && !coordinatesFromLocation(deviceLocation)) {
      setError("Choose a valid device location.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus(selectedDevice.transport === "softap"
      ? `Connecting to ${selectedDevice.name} directly…`
      : `Connecting to ${selectedDevice.name} over Bluetooth…`);
    try {
      await provisioningManager.connect(
        selectedDevice,
        selectedDevice.requiresProofOfPossession ? proofOfPossession.trim() : undefined,
      );
      setConnected(true);
      setStatus("Connected. Review the local HaLow configuration.");
      setStep(3);
    } catch (caught) {
      await provisioningManager.disconnect(selectedDevice);
      setConnected(false);
      setError(caught instanceof Error ? caught.message : "Device connection failed.");
      setStatus("Connection did not complete. Check that provisioning mode is active and retry.");
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    if (!selectedDevice || !connected) {
      setError("The provisioning connection was lost. Go back and reconnect.");
      return;
    }
    const coordinates = deviceLocationChoice === "none" || deviceLocationChoice === "gps"
      ? null
      : coordinatesFromLocation(deviceLocation);
    setBusy(true);
    setError("");
    setStatus("Saving the local HaLow configuration…");
    try {
      const deviceId = await profileDeviceUuid(profile.id, selectedDevice.serial);
      const localInput = {
        clientId: deviceId,
        meshId: profile.meshId,
        passphrase: profile.meshPassphrase,
        country: profile.country,
        halowChannel: profile.halowChannel,
        deviceName: name.trim(),
        softapPassword: selectedDevice.kind === "h7608" ? deviceWifiPassword : undefined,
        useDeviceGps: deviceLocationChoice === "gps",
        ...(coordinates ?? (selectedDevice.supportsDeviceGps ? {} : { latitude: null, longitude: null })),
      } as EdgezProvisioningInput;
      await provisioningManager.configure(selectedDevice, localInput);
      await saveProfileDevice({
        profileId: profile.id,
        serial: selectedDevice.serial,
        name: name.trim() || selectedDevice.serial,
        kind: selectedDevice.kind,
        firmwareTarget: selectedDevice.firmwareTarget,
        locationSource: deviceLocationChoice,
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
      }, deviceId);
      await onProvisioned();
      await provisioningManager.disconnect(selectedDevice);
      setConnected(false);
      setStatus(`Provisioned ${selectedDevice.serial}.`);
      Alert.alert("Device provisioned", `${selectedDevice.name} now uses the ${profile.name} HaLow profile.`, [
        { text: "Done", onPress: onClose },
      ]);
    } catch (caught) {
      await provisioningManager.disconnect(selectedDevice);
      setConnected(false);
      setError(caught instanceof Error ? caught.message : "Provisioning did not complete.");
      setStatus("Provisioning did not complete.");
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (busy) return;
    if (step === 3) {
      void disconnect();
      setStatus(`Confirm the details for ${selectedDevice?.name || "the device"}.`);
      setStep(2);
      return;
    }
    setSelectedDevice(null);
    setStatus("Select a device to provision.");
    setStep(1);
  };

  return (
    <SafeAreaView style={styles.provisioningPage}>
      <StatusBar style="dark" />
      <View style={styles.provisioningHeader}>
        <View>
          <Text style={styles.provisioningEyebrow}>STEP {step} OF 3</Text>
          <Text style={styles.provisioningTitle}>{step === 1 ? "Choose device" : step === 2 ? "Device details" : "Confirm setup"}</Text>
        </View>
        <Pressable onPress={close} disabled={busy} accessibilityRole="button"><Text style={styles.provisioningClose}>CLOSE</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.provisioningContent} keyboardShouldPersistTaps="handled">
        {step === 1 ? (
          <>
            <Text style={styles.provisioningHelp}>Put the ESP32 or nRF54 in provisioning mode, or start an unconfigured H7608. Discovery and setup stay local to the phone.</Text>
            <Pressable style={[styles.provisioningPrimary, busy && styles.disabledButton]} onPress={() => void scan()} disabled={busy}>
              <Text style={styles.provisioningPrimaryText}>{busy ? "SCANNING…" : "SCAN FOR DEVICES"}</Text>
            </Pressable>
            {devices.map((device) => (
              <Pressable key={`${device.kind}-${device.id}`} style={styles.provisioningDevice} onPress={() => selectDevice(device)} disabled={busy}>
                <Text style={styles.provisioningDeviceName}>{device.name}</Text>
                <Text style={styles.settingsMuted}>Serial {device.serial} · {device.kind.toUpperCase()}</Text>
              </Pressable>
            ))}
          </>
        ) : null}

        {step === 2 && selectedDevice ? (
          <>
            <View style={styles.provisioningSummary}>
              <Text style={styles.provisioningDeviceName}>{selectedDevice.name}</Text>
              <Text style={styles.settingsMuted}>Serial {selectedDevice.serial}</Text>
            </View>
            <Text style={styles.provisioningFieldLabel}>NAME</Text>
            <TextInput style={styles.provisioningInput} value={name} onChangeText={setName} placeholder="Device name" placeholderTextColor="#829693" maxLength={selectedDevice.deviceNameMaxLength} />
            <Text style={styles.provisioningFieldLabel}>LOCATION · OPTIONAL</Text>
            <Pressable style={[styles.provisioningChoice, deviceLocationChoice === "none" && styles.provisioningChoiceSelected]} onPress={() => { setDeviceLocationChoice("none"); setDeviceLocation(""); }}>
              <Text style={styles.provisioningDeviceName}>None</Text>
            </Pressable>
            <Pressable style={[styles.provisioningChoice, deviceLocationChoice === "current" && styles.provisioningChoiceSelected]} onPress={() => void chooseCurrentDeviceLocation()} disabled={deviceLocationLoading}>
              <Text style={styles.provisioningDeviceName}>{deviceLocationLoading ? "Finding current location…" : "Current location"}</Text>
              {deviceLocationChoice === "current" ? <Text style={styles.settingsMuted}>{deviceLocation}</Text> : null}
            </Pressable>
            <Pressable style={[styles.provisioningChoice, deviceLocationChoice === "map" && styles.provisioningChoiceSelected]} onPress={() => setLocationPickerOpen(true)}>
              <Text style={styles.provisioningDeviceName}>Choose on map</Text>
              {deviceLocationChoice === "map" ? <Text style={styles.settingsMuted}>{deviceLocation}</Text> : null}
            </Pressable>
            {selectedDevice.supportsDeviceGps ? (
              <Pressable style={[styles.provisioningChoice, deviceLocationChoice === "gps" && styles.provisioningChoiceSelected]} onPress={() => { setDeviceLocationChoice("gps"); setDeviceLocation(""); }}>
                <Text style={styles.provisioningDeviceName}>Device GPS</Text>
                <Text style={styles.settingsMuted}>Use the GPS connected to this device</Text>
              </Pressable>
            ) : null}
            {selectedDevice.requiresProofOfPossession ? (
              <>
                <Text style={styles.provisioningFieldLabel}>{selectedDevice.transport === "softap" ? "CURRENT DEVICE WI-FI PASSWORD" : "PROOF OF POSSESSION (PoP)"}</Text>
                <ProvisioningPasswordField value={proofOfPossession} onChangeText={setProofOfPossession} placeholder="Provisioning password" accessibilityName="provisioning password" />
              </>
            ) : null}
            {selectedDevice.kind === "h7608" ? (
              <>
                <Text style={styles.provisioningFieldLabel}>NEW DEVICE WI-FI PASSWORD</Text>
                <ProvisioningPasswordField value={deviceWifiPassword} onChangeText={setDeviceWifiPassword} placeholder="8–63 characters" accessibilityName="new device Wi-Fi password" />
              </>
            ) : null}
            <Pressable style={[styles.provisioningPrimary, busy && styles.disabledButton]} onPress={() => void connect()} disabled={busy || deviceLocationLoading}>
              <Text style={styles.provisioningPrimaryText}>{busy ? "CONNECTING…" : "CONNECT DEVICE"}</Text>
            </Pressable>
          </>
        ) : null}

        {step === 3 && selectedDevice ? (
          <>
            <View style={styles.provisioningSummary}>
              <Text style={styles.currentProfileLabel}>LOCAL PROFILE</Text>
              <Text style={styles.currentProfileName}>{profile.name}</Text>
              <Text style={styles.settingsMuted}>{profile.country} · {profile.halowChannel === 0 ? "Auto channel" : `Channel ${profile.halowChannel}`}</Text>
              <Text style={styles.settingsMuted}>Mesh ID: {profile.meshId}</Text>
              <Text style={styles.settingsMuted}>Device: {selectedDevice.name}</Text>
            </View>
            <Text style={styles.provisioningHelp}>The app will send the active profile's HaLow mesh settings directly to the device. Upstream network setup is skipped.</Text>
            <Pressable style={[styles.provisioningPrimary, busy && styles.disabledButton]} onPress={() => void provision()} disabled={busy}>
              <Text style={styles.provisioningPrimaryText}>{busy ? "PROVISIONING…" : "PROVISION DEVICE"}</Text>
            </Pressable>
          </>
        ) : null}

        {step > 1 ? <Pressable style={styles.provisioningBack} onPress={back} disabled={busy}><Text style={styles.provisioningBackText}>BACK</Text></Pressable> : null}
        {status ? <Text style={styles.provisioningStatus}>{status}</Text> : null}
        {error ? <Text style={styles.provisioningError}>{error}</Text> : null}
      </ScrollView>
      <Modal visible={locationPickerOpen} animationType="slide" onRequestClose={() => setLocationPickerOpen(false)}>
        <ProfileLocationPicker
          subject="device"
          location={deviceLocation || profile.location}
          country={profile.country}
          onCancel={() => setLocationPickerOpen(false)}
          onSelect={(location) => { setDeviceLocation(location); setDeviceLocationChoice("map"); setLocationPickerOpen(false); }}
        />
      </Modal>
    </SafeAreaView>
  );
}

function BleDebugModal({
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

function SettingsPage({
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

function HomeMap({
  profile,
  devices,
  bleStatus,
  onAddDevice,
  onOpenSettings,
}: {
  profile: StoredProfile;
  devices: StoredDevice[];
  bleStatus: BleLinkStatus;
  onAddDevice: () => void;
  onOpenSettings: () => void;
}) {
  const map = useRef<EdgezOrganicMapRef>(null);
  const profileCenter = coordinatesFromLocation(profile.location);
  const initialZoom = profileCenter ? 12 : 9;
  const mapZoom = useRef(initialZoom);
  const [menuOpen, setMenuOpen] = useState(false);
  const [region, setRegion] = useState("");
  const [download, setDownload] = useState<EdgezMapDownloadUpdate | null>(null);
  const [mapError, setMapError] = useState("");
  const [mapTheme, setMapTheme] = useState<"day" | "night">("day");
  const [debugOpen, setDebugOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const locatedDevices = devices.filter((device) => device.latitude !== null && device.longitude !== null);
  const mapNodes = [
    ...locatedDevices.map((device) => ({
      id: device.id,
      label: device.name,
      icon: device.kind === "h7608" ? "gateway" as const : "tracker" as const,
      latitude: device.latitude as number,
      longitude: device.longitude as number,
    })),
    ...(currentLocation ? [{ id: "current-location", label: "You", icon: "gps" as const, ...currentLocation }] : []),
  ];

  const toggleMapTheme = () => {
    const nextTheme = mapTheme === "day" ? "night" : "day";
    map.current?.setMapTheme(nextTheme);
    setMapTheme(nextTheme);
  };

  const centerOnCurrentLocation = async () => {
    if (locating) return;
    setLocating(true);
    setMapError("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is needed to show your current position.");
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const coordinates = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      setCurrentLocation(coordinates);
      map.current?.setCamera({ ...coordinates, zoom: Math.max(mapZoom.current, 15) });
    } catch (caught) {
      setMapError(caught instanceof Error ? caught.message : "Could not determine the current location.");
    } finally {
      setLocating(false);
    }
  };

  const showOfflineMapHelp = () => {
    setMenuOpen(false);
    Alert.alert(
      "Offline maps",
      "Move the map to the area you need. When that region is available to save, the app will offer to download it for offline use.",
      [{ text: "OK" }],
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={mapTheme === "night" ? "light" : "dark"} />
      <View style={styles.mapCard}>
        <EdgezOrganicMap
          ref={map}
          nodes={mapNodes}
          lines={[]}
          centerLatitude={profileCenter?.latitude ?? 59.3293}
          centerLongitude={profileCenter?.longitude ?? 18.0686}
          zoom={initialZoom}
          enableMapDownloads
          style={styles.map}
          onCameraChanged={({ zoom }) => { mapZoom.current = zoom; }}
          onMapRegionAvailable={setRegion}
          onMapDownloadUpdate={(update) => {
            setRegion("");
            setDownload(update);
          }}
          onMapError={setMapError}
        />

        {region ? (
          <View style={styles.mapPrompt}>
            <Text style={styles.mapPromptTitle}>Save {region} offline?</Text>
            <Text style={styles.mapPromptText}>
              Download this region so the map keeps working without internet.
            </Text>
            <View style={styles.mapPromptActions}>
              <Pressable
                style={styles.mapDownloadButton}
                onPress={() => {
                  map.current?.downloadRegion(region);
                  setRegion("");
                }}
                accessibilityRole="button"
              >
                <Text style={styles.mapDownloadText}>DOWNLOAD</Text>
              </Pressable>
              <Pressable
                style={styles.mapLaterButton}
                onPress={() => {
                  map.current?.dismissDownloadRegion(region);
                  setRegion("");
                }}
                accessibilityRole="button"
              >
                <Text style={styles.mapLaterText}>NOT NOW</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {download && !download.finished ? (
          <View style={styles.mapNotice}>
            <Text style={styles.mapNoticeText}>
              {download.status}
              {download.progress === undefined ? "" : ` · ${Math.round(download.progress)}%`}
            </Text>
          </View>
        ) : null}

        {mapError ? (
          <Pressable style={[styles.mapNotice, styles.mapError]} onPress={() => setMapError("")}>
            <Text style={styles.mapNoticeText}>{mapError}</Text>
          </Pressable>
        ) : null}

        <View style={[styles.mapControls, region && styles.mapControlsRaised]}>
          <Pressable
            style={styles.mapControlButton}
            onPress={() => setDebugOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Show BLE debug. ${bleStatus.label}`}
          >
            {bleStatus.phase === "preparing" || bleStatus.phase === "connecting"
              ? <ActivityIndicator color="#69cfc7" size="small" />
              : <Ionicons
                  name={bleStatus.phase === "ready" ? "bluetooth" : "bluetooth-outline"}
                  size={23}
                  color={bleStatus.phase === "ready"
                    ? "#69cfc7"
                    : bleStatus.phase === "connected"
                      ? "#f2c96d"
                      : bleStatus.phase === "error"
                        ? "#ff826f"
                        : "#90aaa7"}
                />}
            <View style={[
              styles.bleStatusDot,
              bleStatus.phase === "ready" && styles.bleStatusDotReady,
              bleStatus.phase === "connected" && styles.bleStatusDotConnected,
              bleStatus.phase === "error" && styles.bleStatusDotError,
            ]} />
          </Pressable>
          <Pressable
            style={styles.mapControlButton}
            onPress={toggleMapTheme}
            accessibilityRole="button"
            accessibilityLabel={`Use ${mapTheme === "day" ? "night" : "day"} map`}
          >
            <Ionicons name={mapTheme === "day" ? "moon-outline" : "sunny-outline"} size={22} color="white" />
          </Pressable>
          <Pressable
            style={[styles.mapControlButton, locating && styles.disabledButton]}
            onPress={() => void centerOnCurrentLocation()}
            disabled={locating}
            accessibilityRole="button"
            accessibilityLabel={locating ? "Finding current location" : "Show current location"}
          >
            {locating
              ? <ActivityIndicator color="white" size="small" />
              : <Ionicons name="locate-outline" size={23} color="white" />}
          </Pressable>
        </View>

        <Text style={styles.mapAttribution}>{locatedDevices.length} located devices · © OpenStreetMap contributors</Text>
      </View>

      {menuOpen ? (
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setMenuOpen(false)}
          accessibilityLabel="Close menu"
        />
      ) : null}

      <View style={styles.dashboardHeader} pointerEvents="box-none">
        <View />
        <View style={styles.headerActions}>
          <Pressable
            style={styles.addButton}
            onPress={onAddDevice}
            accessibilityRole="button"
            accessibilityLabel="Add device"
          >
            <Text style={styles.addButtonText}>+ ADD</Text>
          </Pressable>
          <Pressable
            style={styles.menuButton}
            onPress={() => setMenuOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel="Open menu"
            accessibilityState={{ expanded: menuOpen }}
          >
            <Text style={styles.menuButtonText}>MENU ⌄</Text>
          </Pressable>
        </View>

        {menuOpen ? (
          <View style={styles.dropdownMenu} accessibilityRole="menu">
            <Pressable style={styles.menuItem} onPress={() => setMenuOpen(false)} accessibilityRole="menuitem">
              <Text style={[styles.menuItemText, styles.menuItemActive]}>Map view</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={showOfflineMapHelp} accessibilityRole="menuitem">
              <Text style={styles.menuItemText}>Offline maps</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
              accessibilityRole="menuitem"
            >
              <Text style={styles.menuItemText}>Settings</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                Alert.alert("Offgrid Tracker", "Local-first device tracking with offline maps.");
              }}
              accessibilityRole="menuitem"
            >
              <Text style={styles.menuItemText}>About</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <BleDebugModal
        visible={debugOpen}
        status={bleStatus}
        onClose={() => setDebugOpen(false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  const [profiles, setProfiles] = useState<StoredProfile[]>([]);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [profileDevices, setProfileDevices] = useState<StoredDevice[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileManagerOpen, setProfileManagerOpen] = useState(false);
  const [profileFormMode, setProfileFormMode] = useState<"create" | "edit" | null>(null);
  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [bleStatus, setBleStatus] = useState<BleLinkStatus>({
    phase: "preparing",
    label: "Preparing BLE connection",
    details: [],
    halowLinkUp: null,
    updatedAt: Date.now(),
  });

  const refreshProfiles = async () => {
    const [availableProfiles, currentProfile] = await Promise.all([listProfiles(), activeProfile()]);
    const availableDevices = currentProfile ? await listProfileDevices(currentProfile.id) : [];
    setProfiles(availableProfiles);
    setProfile(currentProfile);
    setProfileDevices(availableDevices);
    return currentProfile;
  };

  useEffect(() => {
    void (async () => {
      await initializeProfileStore();
      let availableProfiles = await listProfiles();
      if (!availableProfiles.length) {
        const stored = await AsyncStorage.getItem(profileStorageKey);
        if (stored) {
          const parsed: unknown = JSON.parse(stored);
          if (validProfileDetails(parsed)) {
            await createProfile({ ...parsed, ...createProfileIdentity(parsed.name), bleDeviceId: "", bleDeviceName: "" });
            await AsyncStorage.removeItem(profileStorageKey);
          }
        }
        availableProfiles = await listProfiles();
      }
      const currentProfile = await activeProfile();
      const availableDevices = currentProfile ? await listProfileDevices(currentProfile.id) : [];
      setProfiles(availableProfiles);
      setProfile(currentProfile);
      setProfileDevices(availableDevices);
    })()
      .catch((caught) => setSettingsError(caught instanceof Error ? caught.message : "Could not open the local profile database."))
      .finally(() => setProfileLoaded(true));
  }, []);

  const saveInitialProfile = async (details: ProfileDetails) => {
    await createProfile(details);
    await refreshProfiles();
  };

  const saveManagedProfile = async (details: ProfileDetails) => {
    if (profileFormMode === "edit" && profile) await updateProfile(profile.id, details);
    else await createProfile(details);
    await refreshProfiles();
    setProfileFormMode(null);
    setSettingsError("");
  };

  const selectManagedProfile = async (selected: StoredProfile) => {
    setSettingsBusy(true);
    setSettingsError("");
    try {
      await setActiveProfile(selected.id);
      await refreshProfiles();
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : "Could not select the profile.");
    } finally {
      setSettingsBusy(false);
    }
  };

  const requestDeleteProfile = () => {
    if (!profile) return;
    Alert.alert(
      "Delete profile?",
      `Remove ${profile.name} and its local settings from this device?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setSettingsBusy(true);
              setSettingsError("");
              try {
                const nextProfile = await deleteProfile(profile.id);
                const availableProfiles = await listProfiles();
                const availableDevices = nextProfile ? await listProfileDevices(nextProfile.id) : [];
                setProfiles(availableProfiles);
                setProfile(nextProfile);
                setProfileDevices(availableDevices);
                if (!nextProfile) setSettingsOpen(false);
              } catch (caught) {
                setSettingsError(caught instanceof Error ? caught.message : "Could not delete the profile.");
              } finally {
                setSettingsBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaProvider>
      {!profileLoaded ? (
        <SafeAreaView style={styles.loadingPage}>
          <StatusBar style="light" />
          <ActivityIndicator color="#69cfc7" size="large" />
        </SafeAreaView>
      ) : profile ? (
        <>
          {!provisioningOpen ? (
            <ActiveProfileBleLink
              key={`${profile.id}:${profile.bleDeviceId}`}
              profile={profile}
              onStatusChange={setBleStatus}
            />
          ) : null}
          <HomeMap
            key={`${profile.id}:${profile.location}`}
            profile={profile}
            devices={profileDevices}
            bleStatus={bleStatus}
            onAddDevice={() => setProvisioningOpen(true)}
            onOpenSettings={() => { setSettingsError(""); setProfileManagerOpen(false); setSettingsOpen(true); }}
          />
          <Modal
            visible={settingsOpen}
            animationType="slide"
            onRequestClose={() => profileFormMode
              ? setProfileFormMode(null)
              : profileManagerOpen
                ? setProfileManagerOpen(false)
                : setSettingsOpen(false)}
          >
            {profileFormMode ? (
              <ProfileForm
                initialProfile={profileFormMode === "edit" ? profile : undefined}
                required={false}
                onCancel={() => setProfileFormMode(null)}
                onSave={saveManagedProfile}
              />
            ) : (
              <SettingsPage
                profiles={profiles}
                currentProfile={profile}
                bleStatus={bleStatus}
                managerOpen={profileManagerOpen}
                busy={settingsBusy}
                error={settingsError}
                onClose={() => { setProfileManagerOpen(false); setSettingsOpen(false); }}
                onManage={() => setProfileManagerOpen(true)}
                onBack={() => setProfileManagerOpen(false)}
                onSelect={(selected) => void selectManagedProfile(selected)}
                onCreate={() => setProfileFormMode("create")}
                onEdit={() => setProfileFormMode("edit")}
                onDelete={requestDeleteProfile}
              />
            )}
          </Modal>
          <Modal visible={provisioningOpen} animationType="slide" onRequestClose={() => setProvisioningOpen(false)}>
            <ProvisioningFlow
              profile={profile}
              onClose={() => setProvisioningOpen(false)}
              onProvisioned={async () => setProfileDevices(await listProfileDevices(profile.id))}
            />
          </Modal>
        </>
      ) : (
        <ProfileForm required onSave={saveInitialProfile} />
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#dce8e5" },
  loadingPage: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#092e35" },
  profilePage: { flex: 1, backgroundColor: "#092e35" },
  profileContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 48, paddingBottom: 52 },
  profileEyebrow: { color: "#69cfc7", fontSize: 10, fontWeight: "900", letterSpacing: 1.4 },
  profileTitle: { color: "white", fontSize: 34, lineHeight: 41, fontWeight: "900", marginTop: 8 },
  profileDescription: { color: "#b7d7d8", fontSize: 14, lineHeight: 21, marginTop: 12, marginBottom: 30 },
  fieldLabel: { color: "#90aaa7", fontSize: 9, fontWeight: "900", letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  profileInput: { height: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, paddingHorizontal: 17, color: "white", fontSize: 16 },
  identityField: { minHeight: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, paddingHorizontal: 17, justifyContent: "center", backgroundColor: "#123f47" },
  identityValue: { color: "#b7d7d8", fontSize: 13 },
  passphraseField: { height: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, flexDirection: "row", alignItems: "center" },
  passphraseInput: { flex: 1, height: 56, paddingLeft: 17, color: "white", fontSize: 16 },
  passphraseVisibilityButton: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  profileSelect: { minHeight: 58, borderWidth: 1, borderColor: "#36565b", borderRadius: 14, paddingHorizontal: 17, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  profileSelectText: { flexShrink: 1, color: "white", fontSize: 14 },
  profileSelectPlaceholder: { flexShrink: 1, color: "#718a83", fontSize: 14 },
  profileSelectedDeviceText: { flex: 1, gap: 3 },
  profileSelectedDeviceId: { color: "#718a83", fontSize: 10 },
  profileClearDeviceButton: { alignSelf: "flex-start", paddingVertical: 10, paddingHorizontal: 2 },
  profileClearDeviceText: { color: "#69cfc7", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  profileOptionList: { maxHeight: 230, marginTop: 7, borderWidth: 1, borderColor: "#36565b", borderRadius: 12, backgroundColor: "#123f47" },
  profileOption: { minHeight: 48, paddingHorizontal: 16, justifyContent: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#36565b" },
  profileOptionSelected: { backgroundColor: "#1a5057" },
  profileOptionText: { color: "#d8e9e8", fontSize: 13, fontWeight: "700" },
  profileOptionTextSelected: { color: "#69cfc7" },
  profileError: { color: "#ffc0af", fontSize: 12, marginTop: 10 },
  profileSaveButton: { minHeight: 54, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87", marginTop: 16 },
  profileSaveText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  profileCancelButton: { minHeight: 48, alignItems: "center", justifyContent: "center" },
  profileCancelText: { color: "#90aaa7", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  disabledButton: { opacity: 0.5 },
  locationPage: { flex: 1, backgroundColor: "#f7faf9" },
  locationHeader: { minHeight: 76, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  locationEyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  locationTitle: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  locationClose: { color: "#59716f", fontSize: 10, fontWeight: "900" },
  locationMap: { flex: 1, overflow: "hidden", backgroundColor: "#dce8e5" },
  mapCrosshair: { position: "absolute", left: "50%", top: "50%", marginLeft: -18, marginTop: -26, width: 36, height: 52, alignItems: "center", justifyContent: "center" },
  mapCrosshairText: { color: "#0a8c87", fontSize: 42, fontWeight: "900", textShadowColor: "white", textShadowRadius: 4 },
  locationFooter: { paddingHorizontal: 22, paddingVertical: 14, gap: 7, backgroundColor: "#f7faf9" },
  locationHelp: { color: "#59716f", fontSize: 12, lineHeight: 18 },
  locationCoordinates: { color: "#718783", fontSize: 10 },
  locationUseButton: { minHeight: 50, marginTop: 4, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  provisioningPage: { flex: 1, backgroundColor: "#f7faf9" },
  provisioningHeader: { minHeight: 84, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  provisioningEyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  provisioningTitle: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  provisioningClose: { color: "#59716f", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 },
  provisioningContent: { padding: 22, paddingBottom: 42, gap: 10 },
  provisioningHelp: { color: "#59716f", fontSize: 13, lineHeight: 19 },
  provisioningPrimary: { minHeight: 54, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87", marginTop: 4 },
  provisioningPrimaryText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  provisioningDevice: { padding: 15, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", gap: 4 },
  provisioningDeviceName: { color: "#0a3037", fontSize: 14, fontWeight: "900" },
  provisioningSummary: { padding: 16, borderRadius: 14, backgroundColor: "#e9f7f5", gap: 5 },
  provisioningFieldLabel: { color: "#385753", fontSize: 9, fontWeight: "900", letterSpacing: 0.9, marginTop: 6 },
  provisioningInput: { height: 54, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, paddingHorizontal: 15, color: "#0a3037", backgroundColor: "white", fontSize: 14 },
  provisioningChoice: { padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", gap: 4 },
  provisioningChoiceSelected: { borderColor: "#0a8c87", borderWidth: 2, backgroundColor: "#e9f7f5" },
  provisioningPasswordField: { height: 54, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", flexDirection: "row", alignItems: "center" },
  provisioningPasswordInput: { flex: 1, height: 52, paddingLeft: 15, color: "#0a3037", fontSize: 14 },
  provisioningVisibilityButton: { width: 54, height: 52, alignItems: "center", justifyContent: "center" },
  provisioningBack: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  provisioningBackText: { color: "#0a8c87", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  provisioningStatus: { color: "#59716f", fontSize: 11, lineHeight: 16, textAlign: "center" },
  provisioningError: { color: "#b9472f", fontSize: 11, lineHeight: 16, textAlign: "center" },
  bleSelectionPage: { flex: 1, backgroundColor: "#f7faf9" },
  bleSelectionContent: { padding: 22, paddingBottom: 42, gap: 12 },
  bleDeviceRow: { minHeight: 72, padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", flexDirection: "row", alignItems: "center", gap: 10 },
  bleDeviceRowSelected: { borderColor: "#0a8c87", borderWidth: 2, backgroundColor: "#f1fbf9" },
  settingsPage: { flex: 1, backgroundColor: "#f7faf9" },
  settingsHeader: { minHeight: 84, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#dce6e5" },
  settingsEyebrow: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  settingsTitle: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  settingsClose: { color: "#59716f", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 },
  settingsContent: { padding: 22, paddingBottom: 42, gap: 12 },
  currentProfileCard: { padding: 18, borderRadius: 16, backgroundColor: "#e9f7f5", gap: 5 },
  profileCardHeader: { minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  profileCardBleActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  profileCardBleStatus: { maxWidth: 130, minHeight: 28, paddingHorizontal: 9, borderRadius: 14, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "white" },
  profileCardBleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#718a83" },
  profileCardBleText: { flexShrink: 1, color: "#385753", fontSize: 8, fontWeight: "900", letterSpacing: 0.6 },
  profileCardDebugButton: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "white", borderWidth: 1, borderColor: "#b9dad6" },
  bleDebugBackdrop: { flex: 1, padding: 22, justifyContent: "center", backgroundColor: "rgba(4, 25, 30, 0.58)" },
  bleDebugCard: { maxHeight: "82%", padding: 20, borderRadius: 18, backgroundColor: "#f7faf9" },
  bleDebugHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  bleDebugEyebrow: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  bleDebugTitle: { color: "#0a3037", fontSize: 24, fontWeight: "900", marginTop: 3 },
  bleDebugHalowRow: { minHeight: 72, marginTop: 18, paddingHorizontal: 16, borderRadius: 14, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#e9f7f5" },
  bleDebugHalowDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#718a83" },
  bleDebugHalowBody: { flex: 1 },
  bleDebugHalowLabel: { color: "#59716f", fontSize: 8, fontWeight: "900", letterSpacing: 0.9 },
  bleDebugHalowValue: { color: "#0a3037", fontSize: 22, fontWeight: "900", marginTop: 2 },
  bleDebugLive: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  bleDebugSummary: { color: "#385753", fontSize: 13, fontWeight: "800", marginTop: 14 },
  bleDebugUpdated: { color: "#718783", fontSize: 10, marginTop: 4 },
  bleDebugDetails: { marginTop: 14 },
  bleDebugDetailsContent: { gap: 7, paddingBottom: 4 },
  bleDebugDetail: { color: "#385753", fontSize: 12, lineHeight: 17 },
  currentProfileLabel: { color: "#0a8c87", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  currentProfileName: { color: "#0a3037", fontSize: 22, fontWeight: "900", marginBottom: 3 },
  manageProfilesButton: { minHeight: 48, marginTop: 10, borderWidth: 1, borderColor: "#0a8c87", borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "white" },
  settingsMuted: { color: "#59716f", fontSize: 11, lineHeight: 16 },
  settingsSectionLabel: { color: "#718783", fontSize: 9, fontWeight: "900", letterSpacing: 1, marginTop: 8 },
  profileRow: { minHeight: 72, padding: 14, borderWidth: 1, borderColor: "#cedbdc", borderRadius: 12, backgroundColor: "white", flexDirection: "row", alignItems: "center", gap: 10 },
  profileRowSelected: { borderColor: "#0a8c87", borderWidth: 2, backgroundColor: "#f1fbf9" },
  profileRowBody: { flex: 1, gap: 4 },
  profileRowName: { color: "#0a3037", fontSize: 15, fontWeight: "900" },
  profileRowStatus: { color: "#718783", fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  profileRowStatusSelected: { color: "#0a8c87" },
  settingsActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  settingsPrimaryButton: { flex: 1, minHeight: 52, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#0a8c87" },
  settingsPrimaryText: { color: "white", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  settingsOutlineButton: { flex: 1, minHeight: 52, borderWidth: 1, borderColor: "#0a8c87", borderRadius: 12, alignItems: "center", justifyContent: "center" },
  settingsOutlineText: { color: "#0a8c87", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  settingsDangerZone: { marginTop: 12, padding: 16, borderWidth: 1, borderColor: "#e8b5aa", borderRadius: 14, backgroundColor: "#fff4f1" },
  settingsDangerTitle: { color: "#8f3422", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  settingsDangerCopy: { color: "#7f5b53", fontSize: 11, lineHeight: 16, marginTop: 5 },
  settingsDeleteButton: { minHeight: 44, marginTop: 12, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#b9472f" },
  settingsDeleteText: { color: "white", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  settingsError: { color: "#b9472f", fontSize: 11, textAlign: "center", marginTop: 4 },
  mapCard: { flex: 1, overflow: "hidden", backgroundColor: "#dce8e5" },
  map: { ...StyleSheet.absoluteFill },
  dashboardHeader: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    minHeight: 68,
    paddingHorizontal: 22,
    paddingTop: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 2,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  addButton: {
    minHeight: 36,
    paddingHorizontal: 13,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a8c87",
  },
  addButtonText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.7 },
  menuButton: {
    minHeight: 36,
    minWidth: 70,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#092e35e8",
  },
  menuButtonText: { color: "white", fontSize: 10, fontWeight: "900", letterSpacing: 0.7 },
  menuBackdrop: { ...StyleSheet.absoluteFill, zIndex: 1 },
  dropdownMenu: {
    position: "absolute",
    top: 62,
    right: 22,
    minWidth: 156,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: "#092e35",
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  menuItem: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center" },
  menuItemText: { color: "white", fontSize: 13, fontWeight: "700" },
  menuItemActive: { color: "#69cfc7" },
  menuDivider: { height: 1, marginHorizontal: 10, backgroundColor: "#36565b" },
  mapPrompt: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 28,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "#092e35f2",
  },
  mapPromptTitle: { color: "white", fontSize: 14, fontWeight: "900" },
  mapPromptText: { color: "#b8cdca", fontSize: 11, lineHeight: 16, marginTop: 3 },
  mapPromptActions: { flexDirection: "row", gap: 8, marginTop: 10 },
  mapDownloadButton: {
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 9,
    backgroundColor: "#0a8c87",
  },
  mapDownloadText: { color: "white", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  mapLaterButton: { minHeight: 38, justifyContent: "center", paddingHorizontal: 13 },
  mapLaterText: { color: "#90aaa7", fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  mapNotice: {
    position: "absolute",
    left: 12,
    right: 90,
    top: 68,
    borderRadius: 9,
    padding: 9,
    backgroundColor: "#092e35e8",
  },
  mapError: { backgroundColor: "#8f3422e8" },
  mapNoticeText: { color: "white", fontSize: 10, fontWeight: "700" },
  mapControls: { position: "absolute", right: 16, bottom: 34, gap: 10, alignItems: "center" },
  mapControlsRaised: { bottom: 174 },
  mapControlButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: "#092e35e8", elevation: 5, shadowColor: "#000", shadowOpacity: 0.24, shadowRadius: 7, shadowOffset: { width: 0, height: 3 } },
  bleStatusDot: { position: "absolute", right: 7, bottom: 7, width: 8, height: 8, borderRadius: 4, backgroundColor: "#718a83", borderWidth: 1, borderColor: "#092e35" },
  bleStatusDotReady: { backgroundColor: "#69cfc7" },
  bleStatusDotConnected: { backgroundColor: "#f2c96d" },
  bleStatusDotError: { backgroundColor: "#ff826f" },
  mapAttribution: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 5,
    color: "#173e43",
    fontSize: 9,
    textShadowColor: "white",
    textShadowRadius: 4,
  },
});
