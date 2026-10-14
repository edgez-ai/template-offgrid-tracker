import AsyncStorage from "@react-native-async-storage/async-storage";
import { createProfileIdentity } from "./profile-store";
import type { ProfileDetails } from "./profile-store";

export type LocationMode = "off" | "fixed" | "live";

export type SharedProfileSettings = Pick<
  ProfileDetails,
  | "identityName"
  | "identityId"
  | "identityPrivateKey"
  | "identityPublicKey"
  | "location"
  | "bleDeviceId"
  | "bleDeviceName"
> & { locationMode: LocationMode };

const sharedSettingsStorageKey = "offgrid-tracker.settings.v1";

function parsedSharedSettings(value: unknown): SharedProfileSettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Partial<SharedProfileSettings>;
  const valid = typeof settings.identityName === "string" && Boolean(settings.identityName.trim()) &&
    typeof settings.identityId === "string" && Boolean(settings.identityId.trim()) &&
    typeof settings.identityPrivateKey === "string" && Boolean(settings.identityPrivateKey) &&
    typeof settings.identityPublicKey === "string" && Boolean(settings.identityPublicKey) &&
    typeof settings.location === "string" &&
    typeof settings.bleDeviceId === "string" &&
    typeof settings.bleDeviceName === "string";
  if (!valid) return null;
  const legacyMode = settings.locationMode as string | undefined;
  const locationMode: LocationMode = legacyMode === "fixed"
    ? "fixed"
    : legacyMode === "live" || legacyMode === "phone"
      ? "live"
      : legacyMode === "off" || legacyMode === "none"
        ? "off"
        : settings.location
          ? "fixed"
          : "off";
  return { ...settings, locationMode } as SharedProfileSettings;
}

function fromProfile(profile?: ProfileDetails | null): SharedProfileSettings {
  const hasIdentity = profile?.identityId && profile.identityPrivateKey && profile.identityPublicKey;
  const identity = hasIdentity
    ? {
        identityName: profile.identityName || profile.name,
        identityId: profile.identityId,
        identityPrivateKey: profile.identityPrivateKey,
        identityPublicKey: profile.identityPublicKey,
      }
    : createProfileIdentity(profile?.name);
  return {
    ...identity,
    location: profile?.location ?? "",
    locationMode: profile?.location ? "fixed" : "off",
    bleDeviceId: profile?.bleDeviceId ?? "",
    bleDeviceName: profile?.bleDeviceName ?? "",
  };
}

export async function loadSharedProfileSettings(fallback?: ProfileDetails | null): Promise<SharedProfileSettings> {
  const stored = await AsyncStorage.getItem(sharedSettingsStorageKey);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      const settings = parsedSharedSettings(parsed);
      if (settings) {
        if (!(parsed as Partial<SharedProfileSettings>).locationMode) await saveSharedProfileSettings(settings);
        return settings;
      }
    } catch {
      // Replace malformed legacy data with a valid settings record below.
    }
  }
  const settings = fromProfile(fallback);
  await saveSharedProfileSettings(settings);
  return settings;
}

export async function saveSharedProfileSettings(settings: SharedProfileSettings): Promise<void> {
  await AsyncStorage.setItem(sharedSettingsStorageKey, JSON.stringify(settings));
}

export function applySharedProfileSettings<T extends ProfileDetails>(profile: T, settings: SharedProfileSettings): T {
  return { ...profile, ...settings, location: settings.locationMode === "fixed" ? settings.location : "" };
}
