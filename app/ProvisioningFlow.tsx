import Ionicons from "@expo/vector-icons/Ionicons";
import { EdgezProvisioningManager } from "@edgez/react-native-sdk";
import type { EdgezProvisioningDevice, EdgezProvisioningInput } from "@edgez/react-native-sdk";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { styles } from "./app-styles";
import { prepareDeviceCredential } from "./cloud-auth";
import type { PreparedDeviceCredential } from "./cloud-auth";
import { coordinatesFromLocation } from "./mesh-utils";
import { ProfileLocationPicker } from "./ProfileScreens";
import { saveProfileDevice } from "./profile-store";
import type { StoredProfile } from "./profile-store";

type DeviceLocationChoice = "none" | "current" | "map" | "gps";

const provisioningPop = "abcd1234";
const provisioningManager = new EdgezProvisioningManager();

function provisioningDeviceLabel(device: EdgezProvisioningDevice) {
  if (device.kind === "nrf54") return "nRF54";
  if (device.kind === "h7608") return "H7608";
  return "ESP32";
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

export function ProvisioningFlow({
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
  const [preparedCredential, setPreparedCredential] = useState<PreparedDeviceCredential | null>(null);
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
      setPreparedCredential(null);
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
    setPreparedCredential(null);
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
      let credential = preparedCredential;
      if (selectedDevice.kind === "h7608" && !credential) {
        setStatus("Creating the cloud device and MQTT credential…");
        credential = await prepareDeviceCredential(
          profile.id,
          selectedDevice.serial,
          name.trim() || selectedDevice.serial,
          selectedDevice.firmwareTarget,
          true,
        );
        setPreparedCredential(credential);
      }
      setStatus(selectedDevice.transport === "softap"
        ? `Connecting to ${selectedDevice.name} directly…`
        : `Connecting to ${selectedDevice.name} over Bluetooth…`);
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
      const credential = preparedCredential ?? await prepareDeviceCredential(
        profile.id,
        selectedDevice.serial,
        name.trim() || selectedDevice.serial,
        selectedDevice.firmwareTarget,
        selectedDevice.kind === "h7608",
      );
      setPreparedCredential(credential);
      const deviceId = credential.deviceId;
      const localInput = {
        clientId: credential.clientId,
        username: credential.username,
        password: credential.password,
        projectId: credential.projectId,
        channel: credential.channel,
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
        deviceType: "Unspecified",
        marker: "default",
        iconStyle: "sensor",
        userUuid: "",
        lastSeenAt: "",
        meshMacAddress: selectedDevice.serial,
        userPublicKey: "",
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
    setPreparedCredential(null);
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
        <Pressable style={styles.headerTextButton} onPress={close} disabled={busy} hitSlop={8} accessibilityRole="button"><Text style={styles.provisioningClose}>CLOSE</Text></Pressable>
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
                <View style={styles.provisioningDeviceHeader}>
                  <Text style={styles.provisioningDeviceName}>{device.name}</Text>
                  <View style={[styles.provisioningTypeBadge, device.kind === "nrf54" && styles.provisioningTypeBadgeNrf]}>
                    <Text style={[styles.provisioningTypeBadgeText, device.kind === "nrf54" && styles.provisioningTypeBadgeTextNrf]}>{provisioningDeviceLabel(device)}</Text>
                  </View>
                </View>
                <Text style={styles.settingsMuted}>Serial {device.serial} · {device.transport === "softap" ? "Wi-Fi" : "Bluetooth"}</Text>
              </Pressable>
            ))}
          </>
        ) : null}

        {step === 2 && selectedDevice ? (
          <>
            <View style={styles.provisioningSummary}>
              <View style={styles.provisioningDeviceHeader}>
                <Text style={styles.provisioningDeviceName}>{selectedDevice.name}</Text>
                <View style={[styles.provisioningTypeBadge, selectedDevice.kind === "nrf54" && styles.provisioningTypeBadgeNrf]}>
                  <Text style={[styles.provisioningTypeBadgeText, selectedDevice.kind === "nrf54" && styles.provisioningTypeBadgeTextNrf]}>{provisioningDeviceLabel(selectedDevice)}</Text>
                </View>
              </View>
              <Text style={styles.settingsMuted}>Serial {selectedDevice.serial}</Text>
              <Text style={styles.settingsMuted}>{selectedDevice.kind === "nrf54" ? "Device GPS location supported" : `Firmware target ${selectedDevice.firmwareTarget}`}</Text>
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
