import "react-native-get-random-values";
import { edgezNodeDisplayName, edgezNodeId, isEdgezPublicChannel } from "@edgez/react-native-sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fromByteArray } from "base64-js";
import type { EdgezMeshSession, EdgezMeshState } from "@edgez/react-native-sdk";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  activeProfile,
  createProfileIdentity,
  createProfile,
  deleteProfileDevice,
  deleteProfile,
  initializeProfileStore,
  listProfileDevices,
  listProfileMessages,
  listProfiles,
  saveProfileDevice,
  replaceProfileConversation,
  setActiveProfile,
  updateProfile,
} from "./profile-store";
import type { ProfileDetails, StoredDevice, StoredMessage, StoredProfile } from "./profile-store";
import { ActiveProfileBleLink } from "./ActiveProfileBleLink";
import type { BleLinkStatus } from "./ActiveProfileBleLink";
import { styles } from "./app-styles";
import { ProfileForm, validProfileDetails } from "./ProfileScreens";
import { ProvisioningFlow } from "./ProvisioningFlow";
import { SettingsPage } from "./SettingsScreens";
import { HomeMap } from "./HomeMap";
import { normalizedDeviceSerial } from "./mesh-utils";
import {
  applySharedProfileSettings,
  loadSharedProfileSettings,
  saveSharedProfileSettings,
} from "./app-settings";
import type { SharedProfileSettings } from "./app-settings";

const profileStorageKey = "offgrid-tracker.profile.v1";
export default function App() {
  const [profiles, setProfiles] = useState<StoredProfile[]>([]);
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [profileDevices, setProfileDevices] = useState<StoredDevice[]>([]);
  const [profileMessages, setProfileMessages] = useState<StoredMessage[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [sharedSettings, setSharedSettings] = useState<SharedProfileSettings | null>(null);
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
  const [meshLink, setMeshLink] = useState<{ session: EdgezMeshSession; state: EdgezMeshState } | null>(null);
  const persistedNodeFingerprint = useRef("");
  const persistedMessageFingerprint = useRef("");
  const runtimeProfile = useMemo(
    () => profile && sharedSettings ? applySharedProfileSettings(profile, sharedSettings) : profile,
    [profile, sharedSettings],
  );

  const refreshProfiles = async () => {
    const [availableProfiles, currentProfile] = await Promise.all([listProfiles(), activeProfile()]);
    const [availableDevices, availableMessages] = currentProfile
      ? await Promise.all([listProfileDevices(currentProfile.id), listProfileMessages(currentProfile.id)])
      : [[], []];
    setProfiles(availableProfiles);
    setProfile(currentProfile);
    setProfileDevices(availableDevices);
    setProfileMessages(availableMessages);
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
      const settings = await loadSharedProfileSettings(currentProfile ?? availableProfiles[0]);
      const [availableDevices, availableMessages] = currentProfile
        ? await Promise.all([listProfileDevices(currentProfile.id), listProfileMessages(currentProfile.id)])
        : [[], []];
      setProfiles(availableProfiles);
      setProfile(currentProfile);
      setSharedSettings(settings);
      setProfileDevices(availableDevices);
      setProfileMessages(availableMessages);
    })()
      .catch((caught) => setSettingsError(caught instanceof Error ? caught.message : "Could not open the local profile database."))
      .finally(() => setProfileLoaded(true));
  }, []);

  useEffect(() => {
    if (!profile || !meshLink) return;
    const discovered = [...meshLink.state.nodes.values()]
      .filter((node) => !isEdgezPublicChannel(node.nodeNum) && node.lastSeenMs > 0);
    if (!discovered.length) return;
    const fingerprint = `${profile.id}:` + discovered
      .map((node) => `${node.nodeNum}:${node.lastSeenMs}:${node.latitude ?? ""}:${node.longitude ?? ""}`)
      .sort()
      .join("|");
    if (persistedNodeFingerprint.current === fingerprint) return;

    const timer = setTimeout(() => {
      void (async () => {
        const existingDevices = await listProfileDevices(profile.id);
        for (const node of discovered) {
          const serial = edgezNodeId(node.nodeNum).toUpperCase();
          const existing = existingDevices.find((device) =>
            normalizedDeviceSerial(device.meshMacAddress || device.serial) === normalizedDeviceSerial(serial));
          const hasLocation = node.latitude !== undefined && node.longitude !== undefined;
          await saveProfileDevice({
            profileId: profile.id,
            serial,
            name: edgezNodeDisplayName(node),
            kind: node.deviceType.toLowerCase() === "gateway" ? "h7608" : existing?.kind ?? "esp32",
            firmwareTarget: existing?.firmwareTarget || `mesh-${node.deviceType.toLowerCase() || "node"}`,
            locationSource: hasLocation ? "gps" : existing?.locationSource ?? "none",
            latitude: hasLocation ? node.latitude as number : existing?.latitude ?? null,
            longitude: hasLocation ? node.longitude as number : existing?.longitude ?? null,
            deviceType: node.deviceType || existing?.deviceType || "Unspecified",
            userUuid: node.userUuid || existing?.userUuid || "",
            lastSeenAt: new Date(node.lastSeenMs).toISOString(),
            meshMacAddress: edgezNodeId(node.nodeNum).toUpperCase(),
            userPublicKey: node.publicKey.length ? fromByteArray(node.publicKey) : existing?.userPublicKey ?? "",
          }, existing?.id);
        }
        persistedNodeFingerprint.current = fingerprint;
        setProfileDevices(await listProfileDevices(profile.id));
      })().catch((caught) => {
        setSettingsError(caught instanceof Error ? caught.message : "Could not save discovered mesh devices.");
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [meshLink?.state.nodes, profile]);

  useEffect(() => {
    if (!profile || !meshLink) return;
    const conversations = [...meshLink.state.conversations.entries()];
    if (!conversations.length) return;
    const fingerprint = `${profile.id}:` + conversations.map(([nodeNum, items]) =>
      `${nodeNum}:${items.map((item) => `${item.messageUuid}:${item.status}`).join(",")}`).sort().join("|");
    if (persistedMessageFingerprint.current === fingerprint) return;
    const timer = setTimeout(() => {
      void (async () => {
        for (const [nodeNum, items] of conversations) {
          await replaceProfileConversation(profile.id, edgezNodeId(nodeNum).toUpperCase(), items);
        }
        persistedMessageFingerprint.current = fingerprint;
        setProfileMessages(await listProfileMessages(profile.id));
      })().catch((caught) => {
        setSettingsError(caught instanceof Error ? caught.message : "Could not save mesh messages.");
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [meshLink?.state.conversations, profile]);

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

  const saveAppSettings = async (settings: SharedProfileSettings) => {
    await saveSharedProfileSettings(settings);
    setSharedSettings(settings);
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
                const [availableDevices, availableMessages] = nextProfile
                  ? await Promise.all([listProfileDevices(nextProfile.id), listProfileMessages(nextProfile.id)])
                  : [[], []];
                setProfiles(availableProfiles);
                setProfile(nextProfile);
                setProfileDevices(availableDevices);
                setProfileMessages(availableMessages);
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

  const requestRemoveDevice = (device: StoredDevice) => {
    if (!profile) return;
    Alert.alert(
      "Remove device?",
      `${device.name} will be removed from this profile. It can appear again when a new beacon is received.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await deleteProfileDevice(profile.id, device.id);
              setProfileDevices(await listProfileDevices(profile.id));
            })().catch((caught) => {
              setSettingsError(caught instanceof Error ? caught.message : "Could not remove the device.");
            });
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
      ) : runtimeProfile ? (
        <>
          {!provisioningOpen ? (
            <ActiveProfileBleLink
              key={`${runtimeProfile.id}:${runtimeProfile.bleDeviceId}`}
              profile={runtimeProfile}
              locationMode={sharedSettings?.locationMode ?? "off"}
              onStatusChange={setBleStatus}
              onMeshChange={setMeshLink}
            />
          ) : null}
          <HomeMap
            key={`${runtimeProfile.id}:${runtimeProfile.location}`}
            profile={runtimeProfile}
            devices={profileDevices}
            messages={profileMessages}
            bleStatus={bleStatus}
            meshLink={meshLink}
            onAddDevice={() => setProvisioningOpen(true)}
            onRemoveDevice={requestRemoveDevice}
            onMessagesChanged={async () => setProfileMessages(await listProfileMessages(runtimeProfile.id))}
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
                initialProfile={profileFormMode === "edit" ? runtimeProfile : undefined}
                sharedSettings={sharedSettings ?? undefined}
                required={false}
                onCancel={() => setProfileFormMode(null)}
                onSave={saveManagedProfile}
              />
            ) : (
              <SettingsPage
                profiles={profiles}
                currentProfile={runtimeProfile}
                sharedSettings={sharedSettings ?? {
                  identityName: runtimeProfile.identityName,
                  identityId: runtimeProfile.identityId,
                  identityPrivateKey: runtimeProfile.identityPrivateKey,
                  identityPublicKey: runtimeProfile.identityPublicKey,
                  location: runtimeProfile.location,
                  locationMode: runtimeProfile.location ? "fixed" : "off",
                  bleDeviceId: runtimeProfile.bleDeviceId,
                  bleDeviceName: runtimeProfile.bleDeviceName,
                }}
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
                onSaveSharedSettings={saveAppSettings}
              />
            )}
          </Modal>
          <Modal visible={provisioningOpen} animationType="slide" onRequestClose={() => setProvisioningOpen(false)}>
            <ProvisioningFlow
              profile={runtimeProfile}
              onClose={() => setProvisioningOpen(false)}
              onProvisioned={async () => setProfileDevices(await listProfileDevices(runtimeProfile.id))}
            />
          </Modal>
        </>
      ) : (
        <ProfileForm sharedSettings={sharedSettings ?? undefined} required onSave={saveInitialProfile} />
      )}
    </SafeAreaProvider>
  );
}
