import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Account, Client, ExecutionMethod, Functions, ID, Permission, Role, TablesDB, Teams } from "react-native-appwrite";
import { fromByteArray, toByteArray } from "base64-js";
import type { EdgezSensorSample } from "@edgez/react-native-sdk";
import type { StoredProfile } from "./profile-store";
import type { StoredDevice, StoredMessage } from "./profile-store";

export type CloudConnectionState = "login" | "offline" | "online";

type CloudConfig = {
  appwriteEndpoint?: string;
  appwriteProjectId?: string;
  appwritePlatform?: string;
  appwriteDatabaseId?: string;
  appwriteProfileTableId?: string;
  appwriteDeviceTableId?: string;
  appwriteMessageTableId?: string;
  appwriteSensorSampleTableId?: string;
  appwriteFunctionId?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as CloudConfig;
const endpoint = (extra.appwriteEndpoint ?? "").replace(/\/+$/, "");
const projectId = (extra.appwriteProjectId ?? "").trim();
const platform = (extra.appwritePlatform ?? "").trim();
const databaseId = (extra.appwriteDatabaseId ?? "offgrid-tracker").trim();
const profileTableId = (extra.appwriteProfileTableId ?? "profiles").trim();
const functionId = (extra.appwriteFunctionId ?? "offgrid-tracker").trim();

export const cloudAuthConfigured = Boolean(
  endpoint && projectId && projectId !== "<PROJECT_ID>" && platform,
);

const client = cloudAuthConfigured
  ? new Client().setEndpoint(endpoint).setProject(projectId).setPlatform(platform)
  : null;
const account = client ? new Account(client) : null;
const teams = client ? new Teams(client) : null;
const tables = client ? new TablesDB(client) : null;
const functions = client ? new Functions(client) : null;
const sessionCacheKey = `offgrid-tracker:cloud-session:${projectId || "unconfigured"}`;
let cloudSyncQueue: Promise<CloudSyncResult> = Promise.resolve({ syncedAt: "", devices: [], messages: [], sensorSamples: [] });

export type CloudTokenRequest = {
  userId: string;
  phrase: string;
};

export function isCloudAuthError(error: unknown) {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.code === 401 || value?.status === 401;
}

function isCloudNotFound(error: unknown) {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.code === 404 || value?.status === 404;
}

function rowPermissions(profileId: string) {
  return [
    Permission.read(Role.team(profileId)),
    Permission.update(Role.team(profileId, "owner")),
    Permission.delete(Role.team(profileId, "owner")),
  ];
}

export type CloudSyncResult = {
  syncedAt: string;
  devices: StoredDevice[];
  messages: StoredMessage[];
  sensorSamples: EdgezSensorSample[];
};

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

async function rememberCloudSession() {
  if (!account) throw new Error("Cloud login is not configured in this app build.");
  await account.get();
  await AsyncStorage.setItem(sessionCacheKey, "1");
}

export async function requestCloudEmailOtp(email: string) {
  if (!account) throw new Error("Cloud login is not configured in this app build.");
  const token = await account.createEmailToken({ userId: ID.unique(), email, phrase: true });
  return { userId: token.userId, phrase: token.phrase } satisfies CloudTokenRequest;
}

export async function completeCloudToken(userId: string, secret: string) {
  if (!account) throw new Error("Cloud login is not configured in this app build.");
  await account.createSession({ userId, secret });
  await rememberCloudSession();
}

export async function logoutCloudSession() {
  if (!account) throw new Error("Cloud login is not configured in this app build.");
  try {
    await account.deleteSession({ sessionId: "current" });
  } catch (error) {
    if (!isCloudAuthError(error)) throw error;
  }
  await AsyncStorage.removeItem(sessionCacheKey);
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

export async function syncCloudData(
  profileId: string,
  devices: readonly StoredDevice[],
  messages: readonly StoredMessage[],
  sensorSamples: readonly EdgezSensorSample[],
): Promise<CloudSyncResult> {
  if (!functions) throw new Error("Cloud access is not configured in this app build.");
  const run = cloudSyncQueue.catch(() => ({ syncedAt: "", devices: [], messages: [], sensorSamples: [] })).then(async () => {
    const lastSyncKey = `offgrid-tracker:cloud-last-sync:${projectId}:${profileId}`;
    const lastSyncAt = await AsyncStorage.getItem(lastSyncKey) ?? "";
    const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : 0;
    const changedDevices = devices.filter((device) => !lastSyncMs || Date.parse(device.updatedAt) > lastSyncMs);
    const changedMessages = messages.filter((message) => !lastSyncMs || Math.max(message.timestampMs, message.lastAttemptAtMs) > lastSyncMs);
    const changedSensorSamples = sensorSamples.filter((sample) => !lastSyncMs || sample.timestampMs > lastSyncMs);
    const encodedMessages = changedMessages.map((message) => ({
          ...message,
          voicePayload: message.voiceBytes.length && message.voiceBytes.length <= 75000
            ? fromByteArray(message.voiceBytes) : "",
          voiceBytes: undefined,
        }));
    const encodedSamples = changedSensorSamples.map((sample) => ({
          nodeNum: sample.nodeNum.toString(),
          timestampMs: sample.timestampMs,
          data: sample.data,
        }));
    const responses: Array<{
      syncedAt?: string;
      devices?: StoredDevice[];
      messages?: Array<Omit<StoredMessage, "voiceBytes"> & { voicePayload?: string }>;
      sensorSamples?: Array<{ nodeNum: string; timestampMs: number; data: EdgezSensorSample["data"] }>;
    }> = [];
    const batchSize = 20;
    const batchCount = Math.max(1, Math.ceil(Math.max(changedDevices.length, encodedMessages.length, encodedSamples.length) / batchSize));
    for (let batch = 0; batch < batchCount; batch += 1) {
      const execution = await functions.createExecution({
        functionId,
        async: false,
        xpath: "/sync",
        method: ExecutionMethod.POST,
        body: JSON.stringify({
          action: "sync",
          profileId,
          lastSyncAt,
          devices: changedDevices.slice(batch * batchSize, (batch + 1) * batchSize),
          messages: encodedMessages.slice(batch * batchSize, (batch + 1) * batchSize),
          sensorSamples: encodedSamples.slice(batch * batchSize, (batch + 1) * batchSize),
        }),
      });
      if (execution.responseStatusCode < 200 || execution.responseStatusCode >= 300) {
        throw new Error(`Cloud sync failed (${execution.responseStatusCode}).`);
      }
      responses.push(JSON.parse(execution.responseBody || "{}"));
    }
    const response = responses.at(-1) ?? {};
    const unique = <T,>(items: readonly T[], key: (item: T) => string) =>
      [...new Map(items.map((item) => [key(item), item])).values()];
    const result = {
      syncedAt: response.syncedAt ?? "",
      devices: unique(responses.flatMap((item) => item.devices ?? []), (device) => device.id),
      messages: unique(responses.flatMap((item) => item.messages ?? []), (message) => message.messageUuid).map((message) => ({
        ...message,
        voiceBytes: message.voicePayload ? toByteArray(message.voicePayload) : new Uint8Array(),
      })),
      sensorSamples: unique(responses.flatMap((item) => item.sensorSamples ?? []), (sample) => `${sample.nodeNum}:${sample.timestampMs}`).map((sample) => ({
        ...sample,
        nodeNum: BigInt(sample.nodeNum),
      })),
    };
    if (!response.syncedAt || Number.isNaN(Date.parse(response.syncedAt))) {
      throw new Error("Cloud sync returned an invalid watermark.");
    }
    return result;
  });
  cloudSyncQueue = run;
  return run;
}

export async function completeCloudDataSync(profileId: string, syncedAt: string) {
  if (!syncedAt || Number.isNaN(Date.parse(syncedAt))) throw new Error("Cloud sync returned an invalid watermark.");
  await AsyncStorage.setItem(`offgrid-tracker:cloud-last-sync:${projectId}:${profileId}`, syncedAt);
}
