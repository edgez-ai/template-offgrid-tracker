import * as SQLite from "expo-sqlite";
import { EdgezIdentityStore } from "@edgez/react-native-sdk";
import type { EdgezUserIdentity } from "@edgez/react-native-sdk";
import type { EdgezConversationMessage, EdgezSensorData, EdgezSensorSample } from "@edgez/react-native-sdk";
import { fromByteArray, toByteArray } from "base64-js";

const identityFactory = new EdgezIdentityStore();

export type ProfileDetails = {
  name: string;
  identityName: string;
  identityId: string;
  identityPrivateKey: string;
  identityPublicKey: string;
  country: string;
  location: string;
  halowChannel: number;
  meshId: string;
  meshPassphrase: string;
  connectToCloud: boolean;
  bleDeviceId: string;
  bleDeviceName: string;
};

export type StoredProfile = ProfileDetails & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type DeviceDetails = {
  profileId: string;
  serial: string;
  name: string;
  kind: "esp32" | "nrf54" | "h7608";
  firmwareTarget: string;
  locationSource: "none" | "current" | "map" | "gps";
  latitude: number | null;
  longitude: number | null;
  deviceType: string;
  marker: string;
  iconStyle: string;
  userUuid: string;
  lastSeenAt: string;
  meshMacAddress: string;
  userPublicKey: string;
};

export type StoredDevice = DeviceDetails & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  profileId: string;
  messageUuid: string;
  peerSerial: string;
  text: string;
  mine: boolean;
  timestampMs: number;
  status: string;
  voiceBytes: Uint8Array;
  voiceCodec: number;
  durationMs: number;
  retryCount: number;
  retryOfUuid: string;
  lastAttemptAtMs: number;
  deliveryState: string;
  attachmentFileId: string;
  attachmentKind: "" | "voice" | "image";
  attachmentName: string;
  attachmentMimeType: string;
  attachmentSize: number;
};

export type StoredSensorSample = EdgezSensorSample & {
  profileId: string;
};

export type ProvisioningRequestDetails = {
  profileId: string;
  serial: string;
  nodeNum: string;
  userIdHigh: string;
  userIdLow: string;
  userPublicKey: string;
  lastSeenAt: string;
  transport?: "ble" | "mqtt";
  cloudDeviceId?: string;
  gatewayNodeNum?: string;
};

export type StoredProvisioningRequest = ProvisioningRequestDetails & {
  id: string;
  status: "pending" | "accepted";
  firstSeenAt: string;
  acceptedAt: string;
};

export type MessageDeliveryMetadata = Partial<Pick<StoredMessage,
  "retryCount" | "retryOfUuid" | "lastAttemptAtMs" | "deliveryState" |
  "attachmentFileId" | "attachmentKind" | "attachmentName" | "attachmentMimeType" | "attachmentSize"
>>;

type ProfileRow = {
  id: string;
  name: string;
  identity_name: string;
  identity_id: string;
  identity_private_key: string;
  identity_public_key: string;
  country: string;
  location: string;
  halow_channel: number;
  mesh_id: string;
  mesh_passphrase: string;
  connect_to_cloud: number;
  ble_device_id: string;
  ble_device_name: string;
  created_at: string;
  updated_at: string;
};

type DeviceRow = {
  id: string;
  profile_id: string;
  serial: string;
  name: string;
  kind: DeviceDetails["kind"];
  firmware_target: string;
  location_source: DeviceDetails["locationSource"];
  latitude: number | null;
  longitude: number | null;
  device_type: string;
  marker: string;
  icon_style: string;
  user_uuid: string;
  last_seen_at: string;
  mesh_mac_address: string;
  user_public_key: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  profile_id: string;
  message_uuid: string;
  peer_serial: string;
  text: string;
  mine: number;
  timestamp_ms: number;
  status: string;
  voice_bytes: string;
  voice_codec: number;
  duration_ms: number;
  retry_count: number;
  retry_of_uuid: string;
  last_attempt_at_ms: number;
  delivery_state: string;
  attachment_file_id: string;
  attachment_kind: StoredMessage["attachmentKind"];
  attachment_name: string;
  attachment_mime_type: string;
  attachment_size: number;
};

type SensorSampleRow = {
  profile_id: string;
  node_num: string;
  timestamp_ms: number;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  vibration_average: number | null;
  accel_x: number | null;
  accel_y: number | null;
  accel_z: number | null;
  gyro_x: number | null;
  gyro_y: number | null;
  gyro_z: number | null;
  binary_length_bytes: number | null;
};

type ProvisioningRequestRow = {
  id: string;
  profile_id: string;
  serial: string;
  node_num: string;
  user_id_high: string;
  user_id_low: string;
  user_public_key: string;
  status: StoredProvisioningRequest["status"];
  first_seen_at: string;
  last_seen_at: string;
  accepted_at: string;
};

const databaseName = "offgrid-tracker.db";
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

function profileFromRow(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    name: row.name,
    identityName: row.identity_name,
    identityId: row.identity_id,
    identityPrivateKey: row.identity_private_key,
    identityPublicKey: row.identity_public_key,
    country: row.country,
    location: row.location,
    halowChannel: row.halow_channel,
    meshId: row.mesh_id,
    meshPassphrase: row.mesh_passphrase,
    connectToCloud: row.connect_to_cloud === 1,
    bleDeviceId: row.ble_device_id,
    bleDeviceName: row.ble_device_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sensorSampleFromRow(row: SensorSampleRow): StoredSensorSample {
  const data: EdgezSensorData = {};
  if (row.latitude !== null) data.latitude = row.latitude;
  if (row.longitude !== null) data.longitude = row.longitude;
  if (row.altitude !== null) data.altitude = row.altitude;
  if (row.temperature !== null) data.temperature = row.temperature;
  if (row.humidity !== null) data.humidity = row.humidity;
  if (row.pressure !== null) data.pressure = row.pressure;
  if (row.vibration_average !== null) data.vibrationAverage = row.vibration_average;
  if (row.accel_x !== null) data.accelX = row.accel_x;
  if (row.accel_y !== null) data.accelY = row.accel_y;
  if (row.accel_z !== null) data.accelZ = row.accel_z;
  if (row.gyro_x !== null) data.gyroX = row.gyro_x;
  if (row.gyro_y !== null) data.gyroY = row.gyro_y;
  if (row.gyro_z !== null) data.gyroZ = row.gyro_z;
  if (row.binary_length_bytes !== null) data.binaryLengthBytes = row.binary_length_bytes;
  return {
    profileId: row.profile_id,
    nodeNum: BigInt(row.node_num),
    timestampMs: row.timestamp_ms,
    data,
  };
}

function uuidPart(value: string, start: number): bigint {
  return BigInt.asIntN(64, BigInt(`0x${value.replace(/-/g, "").slice(start, start + 16)}`));
}

export function createProfileIdentity(name = "EdgeZ User"): Pick<ProfileDetails, "identityName" | "identityId" | "identityPrivateKey" | "identityPublicKey"> {
  const identity = identityFactory.createIdentity(name);
  return {
    identityName: identity.name,
    identityId: identity.userUuid,
    identityPrivateKey: fromByteArray(identity.privateKey),
    identityPublicKey: fromByteArray(identity.publicKey),
  };
}

export function profileIdentity(profile: ProfileDetails): EdgezUserIdentity {
  return {
    userUuid: profile.identityId,
    userIdHigh: uuidPart(profile.identityId, 0),
    userIdLow: uuidPart(profile.identityId, 16),
    name: profile.identityName,
    privateKey: toByteArray(profile.identityPrivateKey),
    publicKey: toByteArray(profile.identityPublicKey),
  };
}

function deviceFromRow(row: DeviceRow): StoredDevice {
  return {
    id: row.id,
    profileId: row.profile_id,
    serial: row.serial,
    name: row.name,
    kind: row.kind,
    firmwareTarget: row.firmware_target,
    locationSource: row.location_source,
    latitude: row.latitude,
    longitude: row.longitude,
    deviceType: row.device_type,
    marker: row.marker,
    iconStyle: row.icon_style || "sensor",
    userUuid: row.user_uuid,
    lastSeenAt: row.last_seen_at,
    meshMacAddress: row.mesh_mac_address,
    userPublicKey: row.user_public_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageFromRow(row: MessageRow): StoredMessage {
  return {
    profileId: row.profile_id,
    messageUuid: row.message_uuid,
    peerSerial: row.peer_serial,
    text: row.text,
    mine: Boolean(row.mine),
    timestampMs: row.timestamp_ms,
    status: row.status,
    voiceBytes: row.voice_bytes ? toByteArray(row.voice_bytes) : new Uint8Array(),
    voiceCodec: row.voice_codec,
    durationMs: row.duration_ms,
    retryCount: row.retry_count,
    retryOfUuid: row.retry_of_uuid,
    lastAttemptAtMs: row.last_attempt_at_ms,
    deliveryState: row.delivery_state,
    attachmentFileId: row.attachment_file_id,
    attachmentKind: row.attachment_kind,
    attachmentName: row.attachment_name,
    attachmentMimeType: row.attachment_mime_type,
    attachmentSize: row.attachment_size,
  };
}

function provisioningRequestFromRow(row: ProvisioningRequestRow): StoredProvisioningRequest {
  return {
    id: row.id,
    profileId: row.profile_id,
    serial: row.serial,
    nodeNum: row.node_num,
    userIdHigh: row.user_id_high,
    userIdLow: row.user_id_low,
    userPublicKey: row.user_public_key,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    acceptedAt: row.accepted_at,
  };
}

function localUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export async function profileDeviceUuid(profileId: string, serial: string): Promise<string> {
  const db = await database();
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM devices WHERE profile_id = ? AND serial = ?",
    profileId,
    serial,
  );
  return existing?.id ?? localUuid();
}

function newProfileId() {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function database() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(databaseName).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS profiles (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          identity_name TEXT NOT NULL DEFAULT '',
          identity_id TEXT NOT NULL DEFAULT '',
          identity_private_key TEXT NOT NULL DEFAULT '',
          identity_public_key TEXT NOT NULL DEFAULT '',
          country TEXT NOT NULL,
          location TEXT NOT NULL,
          halow_channel INTEGER NOT NULL,
          mesh_id TEXT NOT NULL,
          mesh_passphrase TEXT NOT NULL DEFAULT '',
          connect_to_cloud INTEGER NOT NULL DEFAULT 0 CHECK (connect_to_cloud IN (0, 1)),
          ble_device_id TEXT NOT NULL DEFAULT '',
          ble_device_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL,
          serial TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('esp32', 'nrf54', 'h7608')),
          firmware_target TEXT NOT NULL,
          location_source TEXT NOT NULL CHECK (location_source IN ('none', 'current', 'map', 'gps')),
          latitude REAL,
          longitude REAL,
          device_type TEXT NOT NULL DEFAULT 'Unspecified',
          marker TEXT NOT NULL DEFAULT 'default',
          icon_style TEXT NOT NULL DEFAULT 'sensor',
          user_uuid TEXT NOT NULL DEFAULT '',
          last_seen_at TEXT NOT NULL DEFAULT '',
          mesh_mac_address TEXT NOT NULL DEFAULT '',
          user_public_key TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (profile_id, serial),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS devices_profile_id_idx ON devices(profile_id);
        CREATE TABLE IF NOT EXISTS messages (
          profile_id TEXT NOT NULL,
          message_uuid TEXT NOT NULL,
          peer_serial TEXT NOT NULL,
          text TEXT NOT NULL,
          mine INTEGER NOT NULL CHECK (mine IN (0, 1)),
          timestamp_ms INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          voice_bytes TEXT NOT NULL DEFAULT '',
          voice_codec INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          retry_of_uuid TEXT NOT NULL DEFAULT '',
          last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
          delivery_state TEXT NOT NULL DEFAULT '',
          attachment_file_id TEXT NOT NULL DEFAULT '',
          attachment_kind TEXT NOT NULL DEFAULT '',
          attachment_name TEXT NOT NULL DEFAULT '',
          attachment_mime_type TEXT NOT NULL DEFAULT '',
          attachment_size INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (profile_id, message_uuid),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS messages_profile_peer_time_idx
          ON messages(profile_id, peer_serial, timestamp_ms);
        CREATE TABLE IF NOT EXISTS sensor_samples (
          profile_id TEXT NOT NULL,
          node_num TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          latitude REAL,
          longitude REAL,
          altitude REAL,
          temperature REAL,
          humidity REAL,
          pressure REAL,
          vibration_average REAL,
          accel_x REAL,
          accel_y REAL,
          accel_z REAL,
          gyro_x REAL,
          gyro_y REAL,
          gyro_z REAL,
          binary_length_bytes INTEGER,
          PRIMARY KEY (profile_id, node_num, timestamp_ms),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS sensor_samples_profile_node_time_idx
          ON sensor_samples(profile_id, node_num, timestamp_ms DESC);
        CREATE TABLE IF NOT EXISTS provisioning_requests (
          id TEXT PRIMARY KEY NOT NULL,
          profile_id TEXT NOT NULL,
          serial TEXT NOT NULL,
          node_num TEXT NOT NULL,
          user_id_high TEXT NOT NULL DEFAULT '0',
          user_id_low TEXT NOT NULL DEFAULT '0',
          user_public_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          accepted_at TEXT NOT NULL DEFAULT '',
          UNIQUE (profile_id, node_num),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS provisioning_requests_profile_seen_idx
          ON provisioning_requests(profile_id, last_seen_at DESC);
      `);
      const profileColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(profiles)");
      const profileColumnNames = new Set(profileColumns.map(({ name }) => name));
      if (!profileColumnNames.has("identity_name")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN identity_name TEXT NOT NULL DEFAULT ''");
      }
      if (!profileColumnNames.has("identity_id")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN identity_id TEXT NOT NULL DEFAULT ''");
      }
      if (!profileColumnNames.has("identity_private_key")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN identity_private_key TEXT NOT NULL DEFAULT ''");
      }
      if (!profileColumnNames.has("identity_public_key")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN identity_public_key TEXT NOT NULL DEFAULT ''");
      }
      if (!profileColumnNames.has("ble_device_id")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN ble_device_id TEXT NOT NULL DEFAULT ''");
      }
      if (!profileColumnNames.has("connect_to_cloud")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN connect_to_cloud INTEGER NOT NULL DEFAULT 0");
      }
      if (!profileColumnNames.has("ble_device_name")) {
        await db.execAsync("ALTER TABLE profiles ADD COLUMN ble_device_name TEXT NOT NULL DEFAULT ''");
      }
      const deviceColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(devices)");
      const deviceColumnNames = new Set(deviceColumns.map(({ name }) => name));
      if (!deviceColumnNames.has("device_type")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'Unspecified'");
      }
      if (!deviceColumnNames.has("marker")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN marker TEXT NOT NULL DEFAULT 'default'");
      }
      if (!deviceColumnNames.has("icon_style")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN icon_style TEXT NOT NULL DEFAULT 'sensor'");
      }
      if (!deviceColumnNames.has("user_uuid")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN user_uuid TEXT NOT NULL DEFAULT ''");
      }
      if (!deviceColumnNames.has("last_seen_at")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''");
      }
      if (!deviceColumnNames.has("mesh_mac_address")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN mesh_mac_address TEXT NOT NULL DEFAULT ''");
        await db.execAsync("UPDATE devices SET mesh_mac_address = serial WHERE mesh_mac_address = ''");
      }
      if (!deviceColumnNames.has("user_public_key")) {
        await db.execAsync("ALTER TABLE devices ADD COLUMN user_public_key TEXT NOT NULL DEFAULT ''");
      }
      const messageColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(messages)");
      const messageColumnNames = new Set(messageColumns.map(({ name }) => name));
      if (!messageColumnNames.has("retry_count")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!messageColumnNames.has("retry_of_uuid")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN retry_of_uuid TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("last_attempt_at_ms")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN last_attempt_at_ms INTEGER NOT NULL DEFAULT 0");
      }
      if (!messageColumnNames.has("delivery_state")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("attachment_file_id")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN attachment_file_id TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("attachment_kind")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN attachment_kind TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("attachment_name")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN attachment_name TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("attachment_mime_type")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN attachment_mime_type TEXT NOT NULL DEFAULT ''");
      }
      if (!messageColumnNames.has("attachment_size")) {
        await db.execAsync("ALTER TABLE messages ADD COLUMN attachment_size INTEGER NOT NULL DEFAULT 0");
      }
      const profilesWithoutIdentity = await db.getAllAsync<{ id: string; name: string }>(
        "SELECT id, name FROM profiles WHERE identity_id = '' OR identity_private_key = '' OR identity_public_key = ''",
      );
      for (const profile of profilesWithoutIdentity) {
        const identity = createProfileIdentity(profile.name);
        await db.runAsync(
          "UPDATE profiles SET identity_name = ?, identity_id = ?, identity_private_key = ?, identity_public_key = ? WHERE id = ?",
          identity.identityName,
          identity.identityId,
          identity.identityPrivateKey,
          identity.identityPublicKey,
          profile.id,
        );
      }
      await db.execAsync("PRAGMA user_version = 11");
      return db;
    });
  }
  return databasePromise;
}

export async function initializeProfileStore() {
  await database();
}

export async function listProfiles(): Promise<StoredProfile[]> {
  const db = await database();
  const rows = await db.getAllAsync<ProfileRow>("SELECT * FROM profiles ORDER BY created_at ASC");
  return rows.map(profileFromRow);
}

export async function activeProfile(): Promise<StoredProfile | null> {
  const db = await database();
  const row = await db.getFirstAsync<ProfileRow>(`
    SELECT profiles.*
    FROM profiles
    LEFT JOIN app_state ON app_state.key = 'active_profile_id' AND app_state.value = profiles.id
    ORDER BY CASE WHEN app_state.value IS NOT NULL THEN 0 ELSE 1 END, profiles.created_at ASC
    LIMIT 1
  `);
  if (!row) return null;
  await setActiveProfile(row.id);
  return profileFromRow(row);
}

export async function createProfile(details: ProfileDetails): Promise<StoredProfile> {
  const db = await database();
  const id = newProfileId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO profiles
      (id, name, identity_name, identity_id, identity_private_key, identity_public_key, country, location, halow_channel, mesh_id, mesh_passphrase, connect_to_cloud, ble_device_id, ble_device_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    details.name,
    details.identityName,
    details.identityId,
    details.identityPrivateKey,
    details.identityPublicKey,
    details.country,
    details.location,
    details.halowChannel,
    details.meshId,
    details.meshPassphrase,
    details.connectToCloud ? 1 : 0,
    details.bleDeviceId,
    details.bleDeviceName,
    now,
    now,
  );
  await setActiveProfile(id);
  return { id, ...details, createdAt: now, updatedAt: now };
}

export async function updateProfile(id: string, details: ProfileDetails): Promise<void> {
  const db = await database();
  const result = await db.runAsync(
    `UPDATE profiles
     SET name = ?, identity_name = ?, identity_id = ?, identity_private_key = ?, identity_public_key = ?,
         country = ?, location = ?, halow_channel = ?, mesh_id = ?, mesh_passphrase = ?,
         connect_to_cloud = ?, ble_device_id = ?, ble_device_name = ?, updated_at = ?
     WHERE id = ?`,
    details.name,
    details.identityName,
    details.identityId,
    details.identityPrivateKey,
    details.identityPublicKey,
    details.country,
    details.location,
    details.halowChannel,
    details.meshId,
    details.meshPassphrase,
    details.connectToCloud ? 1 : 0,
    details.bleDeviceId,
    details.bleDeviceName,
    new Date().toISOString(),
    id,
  );
  if (!result.changes) throw new Error("Profile no longer exists.");
}

export async function setActiveProfile(id: string): Promise<void> {
  const db = await database();
  const exists = await db.getFirstAsync<{ id: string }>("SELECT id FROM profiles WHERE id = ?", id);
  if (!exists) throw new Error("Profile no longer exists.");
  await db.runAsync(
    `INSERT INTO app_state (key, value) VALUES ('active_profile_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    id,
  );
}

/** Replace a phone-local profile id with the authoritative cloud profile id.
 * Child rows are moved in the same transaction so switching an existing
 * profile to cloud mode does not discard any offline history. */
export async function adoptCloudProfileId(
  currentId: string,
  cloudId: string,
): Promise<StoredProfile> {
  const db = await database();
  if (currentId === cloudId) {
    const current = await db.getFirstAsync<ProfileRow>(
      "SELECT * FROM profiles WHERE id = ?",
      currentId,
    );
    if (!current) throw new Error("Profile no longer exists.");
    return profileFromRow(current);
  }

  const existing = await db.getFirstAsync<ProfileRow>(
    "SELECT * FROM profiles WHERE id = ?",
    cloudId,
  );
  if (existing) {
    await setActiveProfile(cloudId);
    return profileFromRow(existing);
  }

  await db.withTransactionAsync(async () => {
    const result = await db.runAsync(
      `INSERT INTO profiles
        (id, name, identity_name, identity_id, identity_private_key, identity_public_key,
         country, location, halow_channel, mesh_id, mesh_passphrase, connect_to_cloud,
         ble_device_id, ble_device_name, created_at, updated_at)
       SELECT ?, name, identity_name, identity_id, identity_private_key, identity_public_key,
         country, location, halow_channel, mesh_id, mesh_passphrase, connect_to_cloud,
         ble_device_id, ble_device_name, created_at, updated_at
       FROM profiles WHERE id = ?`,
      cloudId,
      currentId,
    );
    if (!result.changes) throw new Error("Profile no longer exists.");
    for (const table of ["devices", "messages", "sensor_samples", "provisioning_requests"]) {
      await db.runAsync(`UPDATE ${table} SET profile_id = ? WHERE profile_id = ?`, cloudId, currentId);
    }
    await db.runAsync(
      "UPDATE app_state SET value = ? WHERE key = 'active_profile_id' AND value = ?",
      cloudId,
      currentId,
    );
    await db.runAsync("DELETE FROM profiles WHERE id = ?", currentId);
  });

  const adopted = await db.getFirstAsync<ProfileRow>(
    "SELECT * FROM profiles WHERE id = ?",
    cloudId,
  );
  if (!adopted) throw new Error("Could not adopt the cloud profile id.");
  return profileFromRow(adopted);
}

export async function deleteProfile(id: string): Promise<StoredProfile | null> {
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM profiles WHERE id = ?", id);
    await db.runAsync("DELETE FROM app_state WHERE key = 'active_profile_id' AND value = ?", id);
  });
  return activeProfile();
}

export async function listProfileDevices(profileId: string): Promise<StoredDevice[]> {
  const db = await database();
  const rows = await db.getAllAsync<DeviceRow>(
    "SELECT * FROM devices WHERE profile_id = ? ORDER BY created_at ASC",
    profileId,
  );
  return rows.map(deviceFromRow);
}

export async function listProfileMessages(profileId: string): Promise<StoredMessage[]> {
  const db = await database();
  const rows = await db.getAllAsync<MessageRow>(
    "SELECT * FROM messages WHERE profile_id = ? ORDER BY timestamp_ms ASC",
    profileId,
  );
  return rows.map(messageFromRow);
}

export async function listProfileSensorSamples(profileId: string): Promise<StoredSensorSample[]> {
  const db = await database();
  const rows = await db.getAllAsync<SensorSampleRow>(
    "SELECT * FROM sensor_samples WHERE profile_id = ? ORDER BY timestamp_ms ASC",
    profileId,
  );
  return rows.map(sensorSampleFromRow);
}

export async function saveProfileSensorSamples(
  profileId: string,
  samples: ReadonlyArray<EdgezSensorSample>,
): Promise<void> {
  if (!samples.length) return;
  const db = await database();
  await db.withTransactionAsync(async () => {
    for (const sample of samples) {
      const data = sample.data;
      await db.runAsync(
        `INSERT INTO sensor_samples
          (profile_id, node_num, timestamp_ms, latitude, longitude, altitude, temperature, humidity,
           pressure, vibration_average, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z,
           binary_length_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, node_num, timestamp_ms) DO UPDATE SET
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           altitude = excluded.altitude,
           temperature = excluded.temperature,
           humidity = excluded.humidity,
           pressure = excluded.pressure,
           vibration_average = excluded.vibration_average,
           accel_x = excluded.accel_x,
           accel_y = excluded.accel_y,
           accel_z = excluded.accel_z,
           gyro_x = excluded.gyro_x,
           gyro_y = excluded.gyro_y,
           gyro_z = excluded.gyro_z,
           binary_length_bytes = excluded.binary_length_bytes`,
        profileId,
        sample.nodeNum.toString(),
        sample.timestampMs,
        data.latitude ?? null,
        data.longitude ?? null,
        data.altitude ?? null,
        data.temperature ?? null,
        data.humidity ?? null,
        data.pressure ?? null,
        data.vibrationAverage ?? null,
        data.accelX ?? null,
        data.accelY ?? null,
        data.accelZ ?? null,
        data.gyroX ?? null,
        data.gyroY ?? null,
        data.gyroZ ?? null,
        data.binaryLengthBytes ?? null,
      );
    }
  });
}

export async function listProfileProvisioningRequests(profileId: string): Promise<StoredProvisioningRequest[]> {
  const db = await database();
  const rows = await db.getAllAsync<ProvisioningRequestRow>(
    "SELECT * FROM provisioning_requests WHERE profile_id = ? ORDER BY last_seen_at DESC",
    profileId,
  );
  return rows.map(provisioningRequestFromRow);
}

export async function saveProfileProvisioningRequest(
  details: ProvisioningRequestDetails,
): Promise<StoredProvisioningRequest> {
  const db = await database();
  const existing = await db.getFirstAsync<ProvisioningRequestRow>(
    "SELECT * FROM provisioning_requests WHERE profile_id = ? AND node_num = ?",
    details.profileId,
    details.nodeNum,
  );
  if (existing) {
    await db.runAsync(
      `UPDATE provisioning_requests
       SET serial = ?, user_id_high = ?, user_id_low = ?, user_public_key = ?, last_seen_at = ?
       WHERE id = ?`,
      details.serial,
      details.userIdHigh,
      details.userIdLow,
      details.userPublicKey,
      details.lastSeenAt,
      existing.id,
    );
    return provisioningRequestFromRow({ ...existing, serial: details.serial,
      user_id_high: details.userIdHigh, user_id_low: details.userIdLow,
      user_public_key: details.userPublicKey, last_seen_at: details.lastSeenAt });
  }
  const id = localUuid();
  await db.runAsync(
    `INSERT INTO provisioning_requests
      (id, profile_id, serial, node_num, user_id_high, user_id_low, user_public_key,
       status, first_seen_at, last_seen_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '')`,
    id,
    details.profileId,
    details.serial,
    details.nodeNum,
    details.userIdHigh,
    details.userIdLow,
    details.userPublicKey,
    details.lastSeenAt,
    details.lastSeenAt,
  );
  return { id, ...details, status: "pending", firstSeenAt: details.lastSeenAt, acceptedAt: "" };
}

export async function markProvisioningRequestAccepted(profileId: string, id: string): Promise<void> {
  const db = await database();
  const acceptedAt = new Date().toISOString();
  const result = await db.runAsync(
    "UPDATE provisioning_requests SET status = 'accepted', accepted_at = ? WHERE profile_id = ? AND id = ?",
    acceptedAt,
    profileId,
    id,
  );
  if (!result.changes) throw new Error("Provisioning request no longer exists.");
}

export async function deleteProfileProvisioningRequest(
  profileId: string,
  requestId: string,
): Promise<void> {
  const db = await database();
  await db.runAsync(
    "DELETE FROM provisioning_requests WHERE profile_id = ? AND id = ?",
    profileId,
    requestId,
  );
}

export async function replaceProfileConversation(
  profileId: string,
  peerSerial: string,
  messages: ReadonlyArray<EdgezConversationMessage>,
): Promise<void> {
  const db = await database();
  await db.withTransactionAsync(async () => {
    for (const message of messages) {
      await db.runAsync(
        `INSERT INTO messages
          (profile_id, message_uuid, peer_serial, text, mine, timestamp_ms, status, voice_bytes, voice_codec, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, message_uuid) DO UPDATE SET
           peer_serial = excluded.peer_serial,
           text = excluded.text,
           mine = excluded.mine,
           timestamp_ms = excluded.timestamp_ms,
           status = excluded.status,
           voice_bytes = excluded.voice_bytes,
           voice_codec = excluded.voice_codec,
           duration_ms = excluded.duration_ms`,
        profileId,
        message.messageUuid,
        peerSerial,
        message.text,
        message.mine ? 1 : 0,
        message.timestampMs,
        message.status,
        message.voiceBytes.length ? fromByteArray(message.voiceBytes) : "",
        message.voiceCodec,
        message.durationMs,
      );
    }
  });
}

export async function saveProfileMessage(
  profileId: string,
  peerSerial: string,
  message: EdgezConversationMessage,
  delivery: MessageDeliveryMetadata = {},
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `INSERT INTO messages
      (profile_id, message_uuid, peer_serial, text, mine, timestamp_ms, status, voice_bytes, voice_codec, duration_ms,
       retry_count, retry_of_uuid, last_attempt_at_ms, delivery_state, attachment_file_id, attachment_kind,
       attachment_name, attachment_mime_type, attachment_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, message_uuid) DO UPDATE SET
       peer_serial = excluded.peer_serial,
       text = excluded.text,
       mine = excluded.mine,
       timestamp_ms = excluded.timestamp_ms,
       status = excluded.status,
       voice_bytes = excluded.voice_bytes,
       voice_codec = excluded.voice_codec,
       duration_ms = excluded.duration_ms,
       retry_count = excluded.retry_count,
       retry_of_uuid = excluded.retry_of_uuid,
       last_attempt_at_ms = excluded.last_attempt_at_ms,
       delivery_state = excluded.delivery_state,
       attachment_file_id = CASE WHEN excluded.attachment_file_id != '' THEN excluded.attachment_file_id ELSE messages.attachment_file_id END,
       attachment_kind = CASE WHEN excluded.attachment_file_id != '' THEN excluded.attachment_kind ELSE messages.attachment_kind END,
       attachment_name = CASE WHEN excluded.attachment_file_id != '' THEN excluded.attachment_name ELSE messages.attachment_name END,
       attachment_mime_type = CASE WHEN excluded.attachment_file_id != '' THEN excluded.attachment_mime_type ELSE messages.attachment_mime_type END,
       attachment_size = CASE WHEN excluded.attachment_file_id != '' THEN excluded.attachment_size ELSE messages.attachment_size END`,
    profileId,
    message.messageUuid,
    peerSerial,
    message.text,
    message.mine ? 1 : 0,
    message.timestampMs,
    message.status,
    message.voiceBytes.length ? fromByteArray(message.voiceBytes) : "",
    message.voiceCodec,
    message.durationMs,
    delivery.retryCount ?? 0,
    delivery.retryOfUuid ?? "",
    delivery.lastAttemptAtMs ?? message.timestampMs,
    delivery.deliveryState ?? "",
    delivery.attachmentFileId ?? "",
    delivery.attachmentKind ?? "",
    delivery.attachmentName ?? "",
    delivery.attachmentMimeType ?? "",
    delivery.attachmentSize ?? 0,
  );
}

export async function updateMessageDelivery(
  profileId: string,
  messageUuid: string,
  delivery: Required<Pick<MessageDeliveryMetadata, "retryCount" | "lastAttemptAtMs" | "deliveryState">>,
): Promise<void> {
  const db = await database();
  await db.runAsync(
    `UPDATE messages
     SET retry_count = ?, last_attempt_at_ms = ?, delivery_state = ?
     WHERE profile_id = ? AND message_uuid = ?`,
    delivery.retryCount,
    delivery.lastAttemptAtMs,
    delivery.deliveryState,
    profileId,
    messageUuid,
  );
}

export async function reconcileProfileMessageDelivery(profileId: string): Promise<boolean> {
  const db = await database();
  const result = await db.runAsync(
    `UPDATE messages AS root
     SET delivery_state = 'Delivered'
     WHERE root.profile_id = ?
       AND root.mine = 1
       AND root.retry_of_uuid = ''
       AND root.delivery_state != 'Delivered'
       AND (root.status = 'Delivered' OR EXISTS (
         SELECT 1 FROM messages AS attempt
         WHERE attempt.profile_id = root.profile_id
           AND attempt.retry_of_uuid = root.message_uuid
           AND attempt.status = 'Delivered'
       ))`,
    profileId,
  );
  return result.changes > 0;
}

export async function deleteProfileDevice(profileId: string, deviceId: string): Promise<void> {
  const db = await database();
  await db.runAsync("DELETE FROM devices WHERE profile_id = ? AND id = ?", profileId, deviceId);
}

export async function saveProfileDevice(details: DeviceDetails, deviceId?: string): Promise<StoredDevice> {
  const db = await database();
  const existing = deviceId
    ? await db.getFirstAsync<DeviceRow>(
      "SELECT * FROM devices WHERE profile_id = ? AND (id = ? OR serial = ?)",
      details.profileId,
      deviceId,
      details.serial,
    )
    : await db.getFirstAsync<DeviceRow>(
      "SELECT * FROM devices WHERE profile_id = ? AND serial = ?",
      details.profileId,
      details.serial,
    );
  const now = new Date().toISOString();
  if (existing) {
    await db.runAsync(
      `UPDATE devices
       SET serial = ?, name = ?, kind = ?, firmware_target = ?, location_source = ?, latitude = ?, longitude = ?,
           device_type = ?, marker = ?, icon_style = ?, user_uuid = ?, last_seen_at = ?, mesh_mac_address = ?, user_public_key = ?, updated_at = ?
       WHERE id = ?`,
      details.serial,
      details.name,
      details.kind,
      details.firmwareTarget,
      details.locationSource,
      details.latitude,
      details.longitude,
      details.deviceType,
      details.marker,
      details.iconStyle,
      details.userUuid,
      details.lastSeenAt,
      details.meshMacAddress,
      details.userPublicKey,
      now,
      existing.id,
    );
    return { id: existing.id, ...details, createdAt: existing.created_at, updatedAt: now };
  }
  const id = deviceId ?? localUuid();
  await db.runAsync(
    `INSERT INTO devices
      (id, profile_id, serial, name, kind, firmware_target, location_source, latitude, longitude, device_type, marker, icon_style, user_uuid, last_seen_at, mesh_mac_address, user_public_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    details.profileId,
    details.serial,
    details.name,
    details.kind,
    details.firmwareTarget,
    details.locationSource,
    details.latitude,
    details.longitude,
    details.deviceType,
    details.marker,
    details.iconStyle,
    details.userUuid,
    details.lastSeenAt,
    details.meshMacAddress,
    details.userPublicKey,
    now,
    now,
  );
  return { id, ...details, createdAt: now, updatedAt: now };
}
