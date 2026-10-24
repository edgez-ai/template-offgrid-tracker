import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { Account, Client, ExecutionMethod, Functions, ID, Permission, Query, Role, Storage, TablesDB, Teams } from "react-native-appwrite";
import type { EdgezSensorSample } from "@edgez/react-native-sdk";
import type { StoredProfile } from "./profile-store";
import type { ProvisioningRequestDetails, StoredDevice, StoredMessage, StoredProvisioningRequest } from "./profile-store";
import { provisioningRequestFromPacket } from "./halow-provisioning";
import { nodeNumFromSerial } from "./mesh-utils";
import { fromByteArray, toByteArray } from "base64-js";

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

type NativeDevice = {
  $id: string;
  $permissions?: string[];
  serial: string;
  name?: string;
  status: string;
  enabled: boolean;
  halowMac?: string | null;
  gatewayDeviceId?: string | null;
  metadata?: {
    profileId?: string;
    firmwareTarget?: string;
    mqttGateway?: boolean;
    _edgezDiscovery?: {
      publicKey?: string;
      requestPayload?: string;
      firstSeenAt?: string;
      lastSeenAt?: string;
    };
  };
};

export type PreparedDeviceCredential = {
  deviceId: string;
  clientId: string;
  username: string;
  password: string;
  projectId: string;
  channel: string;
};

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

async function devicesRequest<T>(path = "", init?: RequestInit): Promise<T> {
  if (!account) throw new Error("Cloud access is not configured in this app build.");
  const response = await fetch(`${endpoint}/devices${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-appwrite-project": projectId,
      ...init?.headers,
    },
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || "Appwrite Devices request failed.");
  return payload;
}

/**
 * Create (or reuse) the cloud Device and rotate its MQTT credential before a
 * local provisioning transport is opened. H7608 must complete this while the
 * phone still has internet, because joining its SoftAP temporarily replaces
 * the phone's normal Wi-Fi connection.
 */
export async function prepareDeviceCredential(
  profileId: string,
  serial: string,
  name: string,
  firmwareTarget: string,
  mqttGateway: boolean,
): Promise<PreparedDeviceCredential> {
  const normalizedSerial = serial.trim().toUpperCase();
  if (!normalizedSerial) throw new Error("The device did not advertise a serial number.");
  const query = `queries[]=${encodeURIComponent(Query.equal("serial", [normalizedSerial]))}`;
  const listed = await devicesRequest<{ devices: NativeDevice[] }>(`?${query}`);
  let device = listed.devices?.[0];
  if (device?.metadata?.profileId && device.metadata.profileId !== profileId) {
    throw new Error("This device is already assigned to another profile.");
  }
  if (!device) {
    device = await devicesRequest<NativeDevice>("", {
      method: "POST",
      body: JSON.stringify({
        serial: normalizedSerial,
        name: name.trim() || normalizedSerial,
        enabled: true,
        permissions: rowPermissions(profileId),
        metadata: { profileId, firmwareTarget, mqttGateway },
      }),
    });
  }
  const credential = await devicesRequest<{
    clientId: string;
    username: string;
    password: string;
  }>(`/${encodeURIComponent(device.$id)}/credentials`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (credential.username.toUpperCase() !== normalizedSerial) {
    throw new Error("The server returned an MQTT username that does not match the device serial.");
  }
  return {
    deviceId: device.$id,
    clientId: credential.clientId,
    username: credential.username,
    password: credential.password,
    projectId,
    channel: "status",
  };
}

/** Return cloud discoveries routed through a gateway assigned to this profile. */
export async function listCloudDiscoveredDevices(
  profileId: string,
): Promise<StoredProvisioningRequest[]> {
  const query = [
    Query.equal("status", ["discovered"]),
    Query.equal("enabled", [false]),
    Query.limit(100),
  ].map((value) => `queries[]=${encodeURIComponent(value)}`).join("&");
  const result = await devicesRequest<{ devices: NativeDevice[]; total?: number }>(`?${query}`);
  const devices = result.devices ?? [];
  const byId = new Map(devices.map((device) => [device.$id, device]));
  const requests: StoredProvisioningRequest[] = [];
  for (const device of devices) {
    if (device.status !== "discovered" || device.enabled || !device.gatewayDeviceId) continue;
    let gateway = byId.get(device.gatewayDeviceId);
    if (!gateway) {
      try {
        gateway = await devicesRequest<NativeDevice>(`/${encodeURIComponent(device.gatewayDeviceId)}`);
      } catch {
        continue;
      }
    }
    const profilePermission = `team:${profileId}`;
    const belongsToProfile = gateway.metadata?.profileId === profileId ||
      [...device.$permissions ?? [], ...gateway.$permissions ?? []]
        .some((permission) => permission.includes(profilePermission));
    if (!belongsToProfile) continue;
    const discovery = device.metadata?._edgezDiscovery;
    if (!discovery?.requestPayload) continue;
    let parsed: ProvisioningRequestDetails | null = null;
    try {
      parsed = provisioningRequestFromPacket(profileId, toByteArray(discovery.requestPayload));
    } catch {
      // Ignore a malformed server record without hiding other valid discoveries.
    }
    if (!parsed) continue;
    const gatewayNodeNum = nodeNumFromSerial(gateway.halowMac || gateway.serial)?.toString() ?? "";
    requests.push({
      ...parsed,
      id: device.$id,
      status: "pending",
      firstSeenAt: discovery.firstSeenAt || parsed.lastSeenAt,
      lastSeenAt: discovery.lastSeenAt || parsed.lastSeenAt,
      acceptedAt: "",
      transport: "mqtt",
      cloudDeviceId: device.$id,
      gatewayNodeNum,
    });
  }
  return requests;
}

/** Publish an encrypted acceptance through the gateway's system MQTT topic. */
export async function acceptCloudProvisioningRequest(
  deviceId: string,
  packet: Uint8Array,
): Promise<void> {
  if (!deviceId) throw new Error("The cloud discovery record is missing.");
  await devicesRequest(`/${encodeURIComponent(deviceId)}/discovery`, {
    method: "PATCH",
    body: JSON.stringify({ payload: fromByteArray(packet) }),
  });
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
