import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { Account, Client, ExecutionMethod, Functions, ID, Permission, Role, Storage, TablesDB, Teams } from "react-native-appwrite";
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
  appwriteMessageAttachmentBucketId?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as CloudConfig;
const endpoint = (extra.appwriteEndpoint ?? "").replace(/\/+$/, "");
const projectId = (extra.appwriteProjectId ?? "").trim();
const platform = (extra.appwritePlatform ?? "").trim();
const databaseId = (extra.appwriteDatabaseId ?? "offgrid-tracker").trim();
const profileTableId = (extra.appwriteProfileTableId ?? "profiles").trim();
const functionId = (extra.appwriteFunctionId ?? "offgrid-tracker").trim();
const messageAttachmentBucketId = (extra.appwriteMessageAttachmentBucketId ?? "message-attachments").trim();

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
const storage = client ? new Storage(client) : null;
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

function stableAttachmentId(profileId: string, messageUuid: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  const value = `${profileId}:${messageUuid}`;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `attachment-${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export type CloudAttachment = {
  attachmentFileId: string;
  attachmentKind: "voice" | "image";
  attachmentName: string;
  attachmentMimeType: string;
  attachmentSize: number;
};

export async function uploadCloudAttachment(
  profileId: string,
  messageUuid: string,
  kind: CloudAttachment["attachmentKind"],
  file: { name: string; type: string; size: number; uri: string },
): Promise<CloudAttachment> {
  if (!storage) throw new Error("Cloud storage is not configured in this app build.");
  const fileId = stableAttachmentId(profileId, messageUuid);
  try {
    await storage.getFile({ bucketId: messageAttachmentBucketId, fileId });
  } catch (error) {
    if (!isCloudNotFound(error)) throw error;
    await storage.createFile({
      bucketId: messageAttachmentBucketId,
      fileId,
      file,
      permissions: rowPermissions(profileId),
    });
  }
  return {
    attachmentFileId: fileId,
    attachmentKind: kind,
    attachmentName: file.name,
    attachmentMimeType: file.type,
    attachmentSize: file.size,
  };
}

async function downloadVoiceAttachment(message: Pick<StoredMessage, "attachmentKind" | "attachmentFileId">) {
  if (message.attachmentKind !== "voice" || !message.attachmentFileId || !storage) return new Uint8Array();
  try {
    return new Uint8Array(await storage.getFileDownload({
      bucketId: messageAttachmentBucketId,
      fileId: message.attachmentFileId,
    }));
  } catch (error) {
    // A deleted attachment must not prevent unrelated messages, devices, and
    // sensor samples from syncing. Transient/auth failures still fail the sync
    // so its watermark is not advanced and the download can be retried.
    if (isCloudNotFound(error)) return new Uint8Array();
    throw error;
  }
}

async function uploadVoiceAttachment(profileId: string, message: StoredMessage): Promise<CloudAttachment | null> {
  if (!message.voiceBytes.length) return null;
  const temporary = new File(Paths.cache, `${stableAttachmentId(profileId, message.messageUuid)}.opus`);
  temporary.create({ overwrite: true });
  try {
    temporary.write(message.voiceBytes);
    return await uploadCloudAttachment(profileId, message.messageUuid, "voice", {
      name: `${message.messageUuid}.opus`,
      type: "audio/opus",
      size: message.voiceBytes.length,
      uri: temporary.uri,
    });
  } finally {
    if (temporary.exists) temporary.delete();
  }
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
    identityId: profile.identityId,
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
  identityId: string,
  devices: readonly StoredDevice[],
  messages: readonly StoredMessage[],
  sensorSamples: readonly EdgezSensorSample[],
): Promise<CloudSyncResult> {
  if (!functions) throw new Error("Cloud access is not configured in this app build.");
  const run = cloudSyncQueue.catch(() => ({ syncedAt: "", devices: [], messages: [], sensorSamples: [] })).then(async () => {
    if (!identityId) throw new Error("The active profile has no messaging identity.");
    const lastSyncKey = `offgrid-tracker:cloud-last-sync-v2:${projectId}:${identityId}`;
    const lastSyncAt = await AsyncStorage.getItem(lastSyncKey) ?? "";
    const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : 0;
    const changedDevices = devices.filter((device) => !lastSyncMs || Date.parse(device.updatedAt) > lastSyncMs);
    const changedMessages = messages.filter((message) => !lastSyncMs || Math.max(message.timestampMs, message.lastAttemptAtMs) > lastSyncMs);
    const changedSensorSamples = sensorSamples.filter((sample) => !lastSyncMs || sample.timestampMs > lastSyncMs);
    const normalizedEndpoint = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const peerIdentity = (message: StoredMessage) => devices.find((device) =>
      [device.serial, device.meshMacAddress].some((value) =>
        value && normalizedEndpoint(value) === normalizedEndpoint(message.peerSerial)))?.userUuid || message.peerSerial;
    const encodedMessages = await Promise.all(changedMessages.map(async (message) => {
      const uploaded = message.attachmentFileId ? null : await uploadVoiceAttachment(profileId, message);
      const peer = peerIdentity(message);
      return {
        messageUuid: message.messageUuid,
        from: message.mine ? identityId : peer,
        to: message.mine ? peer : identityId,
        text: message.text,
        timestampMs: message.timestampMs,
        status: message.status,
        voiceCodec: message.voiceCodec,
        durationMs: message.durationMs,
        retryCount: message.retryCount,
        retryOfUuid: message.retryOfUuid,
        lastAttemptAtMs: message.lastAttemptAtMs,
        deliveryState: message.deliveryState,
        attachmentFileId: message.attachmentFileId,
        attachmentKind: message.attachmentKind,
        attachmentName: message.attachmentName,
        attachmentMimeType: message.attachmentMimeType,
        attachmentSize: message.attachmentSize,
        ...(uploaded ?? {}),
      };
    }));
    const encodedSamples = changedSensorSamples.map((sample) => ({
          nodeNum: sample.nodeNum.toString(),
          timestampMs: sample.timestampMs,
          data: sample.data,
        }));
    const responses: Array<{
      syncedAt?: string;
      devices?: StoredDevice[];
      messages?: Array<Omit<StoredMessage, "profileId" | "peerSerial" | "mine" | "voiceBytes"> & { from: string; to: string }>;
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
          identityId,
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
      messages: await Promise.all(unique(responses.flatMap((item) => item.messages ?? []), (message) => message.messageUuid).map(async (message) => ({
        ...message,
        profileId,
        mine: message.from === identityId,
        peerSerial: (() => {
          const endpoint = message.from === identityId ? message.to : message.from;
          return devices.find((device) => device.userUuid === endpoint)?.serial || endpoint;
        })(),
        attachmentFileId: message.attachmentFileId ?? "",
        attachmentKind: message.attachmentKind ?? "",
        attachmentName: message.attachmentName ?? "",
        attachmentMimeType: message.attachmentMimeType ?? "",
        attachmentSize: message.attachmentSize ?? 0,
        voiceBytes: await downloadVoiceAttachment(message),
      }))),
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

export async function completeCloudDataSync(identityId: string, syncedAt: string) {
  if (!syncedAt || Number.isNaN(Date.parse(syncedAt))) throw new Error("Cloud sync returned an invalid watermark.");
  if (!identityId) throw new Error("The active profile has no messaging identity.");
  await AsyncStorage.setItem(`offgrid-tracker:cloud-last-sync-v2:${projectId}:${identityId}`, syncedAt);
}
