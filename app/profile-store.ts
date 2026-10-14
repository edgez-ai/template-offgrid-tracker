import * as SQLite from "expo-sqlite";
import { EdgezIdentityStore } from "@edgez/react-native-sdk";
import type { EdgezUserIdentity } from "@edgez/react-native-sdk";
import type { EdgezConversationMessage } from "@edgez/react-native-sdk";
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
};

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
    bleDeviceId: row.ble_device_id,
    bleDeviceName: row.ble_device_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
          PRIMARY KEY (profile_id, message_uuid),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS messages_profile_peer_time_idx
          ON messages(profile_id, peer_serial, timestamp_ms);
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
      await db.execAsync("PRAGMA user_version = 7");
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
      (id, name, identity_name, identity_id, identity_private_key, identity_public_key, country, location, halow_channel, mesh_id, mesh_passphrase, ble_device_id, ble_device_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
         ble_device_id = ?, ble_device_name = ?, updated_at = ?
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

export async function replaceProfileConversation(
  profileId: string,
  peerSerial: string,
  messages: ReadonlyArray<EdgezConversationMessage>,
): Promise<void> {
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "DELETE FROM messages WHERE profile_id = ? AND peer_serial = ?",
      profileId,
      peerSerial,
    );
    for (const message of messages) {
      await db.runAsync(
        `INSERT INTO messages
          (profile_id, message_uuid, peer_serial, text, mine, timestamp_ms, status, voice_bytes, voice_codec, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
): Promise<void> {
  const db = await database();
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
           device_type = ?, marker = ?, user_uuid = ?, last_seen_at = ?, mesh_mac_address = ?, user_public_key = ?, updated_at = ?
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
      (id, profile_id, serial, name, kind, firmware_target, location_source, latitude, longitude, device_type, marker, user_uuid, last_seen_at, mesh_mac_address, user_public_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    details.userUuid,
    details.lastSeenAt,
    details.meshMacAddress,
    details.userPublicKey,
    now,
    now,
  );
  return { id, ...details, createdAt: now, updatedAt: now };
}
