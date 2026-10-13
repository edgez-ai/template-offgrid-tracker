import * as SQLite from "expo-sqlite";

export type ProfileDetails = {
  name: string;
  country: string;
  location: string;
  halowChannel: number;
  meshId: string;
  meshPassphrase: string;
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
};

export type StoredDevice = DeviceDetails & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  name: string;
  country: string;
  location: string;
  halow_channel: number;
  mesh_id: string;
  mesh_passphrase: string;
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
  created_at: string;
  updated_at: string;
};

const databaseName = "offgrid-tracker.db";
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

function profileFromRow(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    location: row.location,
    halowChannel: row.halow_channel,
    meshId: row.mesh_id,
    meshPassphrase: row.mesh_passphrase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function localUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
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
          country TEXT NOT NULL,
          location TEXT NOT NULL,
          halow_channel INTEGER NOT NULL,
          mesh_id TEXT NOT NULL,
          mesh_passphrase TEXT NOT NULL DEFAULT '',
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
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (profile_id, serial),
          FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS devices_profile_id_idx ON devices(profile_id);
        PRAGMA user_version = 2;
      `);
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
      (id, name, country, location, halow_channel, mesh_id, mesh_passphrase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    details.name,
    details.country,
    details.location,
    details.halowChannel,
    details.meshId,
    details.meshPassphrase,
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
     SET name = ?, country = ?, location = ?, halow_channel = ?, mesh_id = ?, mesh_passphrase = ?, updated_at = ?
     WHERE id = ?`,
    details.name,
    details.country,
    details.location,
    details.halowChannel,
    details.meshId,
    details.meshPassphrase,
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

export async function saveProfileDevice(details: DeviceDetails): Promise<StoredDevice> {
  const db = await database();
  const existing = await db.getFirstAsync<DeviceRow>(
    "SELECT * FROM devices WHERE profile_id = ? AND serial = ?",
    details.profileId,
    details.serial,
  );
  const now = new Date().toISOString();
  if (existing) {
    await db.runAsync(
      `UPDATE devices
       SET name = ?, kind = ?, firmware_target = ?, location_source = ?, latitude = ?, longitude = ?, updated_at = ?
       WHERE id = ?`,
      details.name,
      details.kind,
      details.firmwareTarget,
      details.locationSource,
      details.latitude,
      details.longitude,
      now,
      existing.id,
    );
    return { id: existing.id, ...details, createdAt: existing.created_at, updatedAt: now };
  }
  const id = localUuid();
  await db.runAsync(
    `INSERT INTO devices
      (id, profile_id, serial, name, kind, firmware_target, location_source, latitude, longitude, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    details.profileId,
    details.serial,
    details.name,
    details.kind,
    details.firmwareTarget,
    details.locationSource,
    details.latitude,
    details.longitude,
    now,
    now,
  );
  return { id, ...details, createdAt: now, updatedAt: now };
}
