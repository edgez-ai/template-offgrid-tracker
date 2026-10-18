import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Account, Client, ID, Permission, Role, TablesDB, Teams } from "react-native-appwrite";
import type { StoredProfile } from "./profile-store";

export type CloudConnectionState = "login" | "offline" | "online";

type CloudConfig = {
  appwriteEndpoint?: string;
  appwriteProjectId?: string;
  appwritePlatform?: string;
  appwriteDatabaseId?: string;
  appwriteProfileTableId?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as CloudConfig;
const endpoint = (extra.appwriteEndpoint ?? "").replace(/\/+$/, "");
const projectId = (extra.appwriteProjectId ?? "").trim();
const platform = (extra.appwritePlatform ?? "").trim();
const databaseId = (extra.appwriteDatabaseId ?? "offgrid-tracker").trim();
const profileTableId = (extra.appwriteProfileTableId ?? "profiles").trim();

export const cloudAuthConfigured = Boolean(
  endpoint && projectId && projectId !== "<PROJECT_ID>" && platform,
);

const client = cloudAuthConfigured
  ? new Client().setEndpoint(endpoint).setProject(projectId).setPlatform(platform)
  : null;
const account = client ? new Account(client) : null;
const teams = client ? new Teams(client) : null;
const tables = client ? new TablesDB(client) : null;
const sessionCacheKey = `offgrid-tracker:cloud-session:${projectId || "unconfigured"}`;

export function isCloudAuthError(error: unknown) {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.code === 401 || value?.status === 401;
}

function isCloudNotFound(error: unknown) {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.code === 404 || value?.status === 404;
}

export function cloudErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Cloud login failed.";
}

export async function cachedCloudSession() {
  return cloudAuthConfigured && await AsyncStorage.getItem(sessionCacheKey) === "1";
}

export async function verifyCloudSession() {
  if (!account) return false;
  try {
    await account.get();
    await AsyncStorage.setItem(sessionCacheKey, "1");
    return true;
  } catch (error) {
    if (isCloudAuthError(error)) {
      await AsyncStorage.removeItem(sessionCacheKey);
      return false;
    }
    throw error;
  }
}

export async function authenticateCloud(email: string, password: string, register = false) {
  if (!account) throw new Error("Cloud login is not configured in this app build.");
  if (register) await account.create({ userId: ID.unique(), email, password });
  await account.createEmailPasswordSession({ email, password });
  await account.get();
  await AsyncStorage.setItem(sessionCacheKey, "1");
}

export async function syncCloudProfile(profile: StoredProfile) {
  if (!account || !teams || !tables) throw new Error("Cloud access is not configured in this app build.");
  const user = await account.get();

  try {
    await teams.get({ teamId: profile.id });
  } catch (error) {
    if (!isCloudNotFound(error)) throw error;
    await teams.create({ teamId: profile.id, name: profile.name });
  }

  const data = {
    name: profile.name,
    country: profile.country,
    location: profile.location,
    halowChannel: profile.halowChannel,
    meshId: profile.meshId,
    meshPassphrase: profile.meshPassphrase,
    teamId: profile.id,
    ownerId: user.$id,
  };
  try {
    await tables.getRow({ databaseId, tableId: profileTableId, rowId: profile.id });
    await tables.updateRow({ databaseId, tableId: profileTableId, rowId: profile.id, data });
  } catch (error) {
    if (!isCloudNotFound(error)) throw error;
    await tables.createRow({
      databaseId,
      tableId: profileTableId,
      rowId: profile.id,
      data,
      permissions: [
        Permission.read(Role.team(profile.id)),
        Permission.update(Role.team(profile.id, "owner")),
        Permission.delete(Role.team(profile.id, "owner")),
      ],
    });
  }

  await account.updatePrefs({ prefs: { ...user.prefs, currentProfileId: profile.id } });
}
