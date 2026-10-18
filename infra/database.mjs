import { config, ensure, run } from "./appwrite.mjs";

function stringColumn(key, size) {
  const common = ["--database-id", config.databaseId, "--table-id", config.telemetryTableId];
  ensure(`telemetry.${key} column`,
    ["tables-db", "get-column", ...common, "--key", key],
    ["tables-db", "create-string-column", ...common, "--key", key, "--size", size, "--required", "true"]);
}

function optionalStringColumn(key, size) {
  const common = ["--database-id", config.databaseId, "--table-id", config.telemetryTableId];
  ensure(`telemetry.${key} column`,
    ["tables-db", "get-column", ...common, "--key", key],
    ["tables-db", "create-string-column", ...common, "--key", key, "--size", size]);
}

export function installDatabase() {
  ensure("database",
    ["tables-db", "get", "--database-id", config.databaseId],
    ["tables-db", "create", "--database-id", config.databaseId, "--name", `${config.name} database`]);

  const profiles = ["--database-id", config.databaseId, "--table-id", config.profileTableId];
  ensure("profiles table",
    ["tables-db", "get-table", ...profiles],
    ["tables-db", "create-table", ...profiles, "--name", "Profiles", "--permissions", 'create("users")', "--row-security", "true"]);
  run(["tables-db", "update-table", ...profiles, "--permissions", 'create("users")', "--row-security", "true"]);
  for (const [key, size] of [["name", "128"], ["country", "2"], ["location", "128"], ["meshId", "32"], ["teamId", "36"], ["ownerId", "36"]]) {
    ensure(`profiles.${key} column`,
      ["tables-db", "get-column", ...profiles, "--key", key],
      ["tables-db", "create-string-column", ...profiles, "--key", key, "--size", size, "--required", "true"]);
  }
  ensure("profiles.halowChannel column",
    ["tables-db", "get-column", ...profiles, "--key", "halowChannel"],
    ["tables-db", "create-integer-column", ...profiles, "--key", "halowChannel", "--min", "0", "--max", "255", "--required", "true"]);
  // Reconcile existing profiles too: channel 0 means automatic selection.
  run(["tables-db", "update-integer-column", ...profiles, "--key", "halowChannel", "--min", "0", "--max", "255", "--required", "true"]);
  ensure("profiles.meshPassphrase column",
    ["tables-db", "get-column", ...profiles, "--key", "meshPassphrase"],
    ["tables-db", "create-string-column", ...profiles, "--key", "meshPassphrase", "--size", "63", "--required", "true", "--encrypt", "true"]);
  ensure("profiles team index",
    ["tables-db", "get-index", ...profiles, "--key", "team-id"],
    ["tables-db", "create-index", ...profiles, "--key", "team-id", "--type", "key", "--columns", "teamId"]);

  const telemetry = ["--database-id", config.databaseId, "--table-id", config.telemetryTableId];
  ensure("telemetry table",
    ["tables-db", "get-table", ...telemetry],
    ["tables-db", "create-table", ...telemetry, "--name", "Latest telemetry", "--row-security", "true"]);
  run(["tables-db", "update-table", ...telemetry, "--name", "Latest telemetry", "--row-security", "true"]);
  stringColumn("deviceId", "36");
  optionalStringColumn("profileId", "36");
  optionalStringColumn("halowMac", "17");
  optionalStringColumn("gatewayDeviceId", "36");
  stringColumn("serial", "36");
  stringColumn("channel", "160");
  ensure("telemetry.status column",
    ["tables-db", "get-column", ...telemetry, "--key", "status"],
    ["tables-db", "create-string-column", ...telemetry, "--key", "status", "--size", "32"]);
  stringColumn("topic", "320");
  stringColumn("payload", "10000");
  ensure("telemetry.location column",
    ["tables-db", "get-column", ...telemetry, "--key", "location"],
    ["tables-db", "create-point-column", ...telemetry, "--key", "location"]);
  for (const [key, size] of [["icon", "32"], ["markerColor", "32"]]) {
    ensure(`telemetry.${key} column`,
      ["tables-db", "get-column", ...telemetry, "--key", key],
      ["tables-db", "create-string-column", ...telemetry, "--key", key, "--size", size]);
  }
  stringColumn("receivedAt", "40");
  ensure("telemetry received-at index",
    ["tables-db", "get-index", ...telemetry, "--key", "received-at"],
    ["tables-db", "create-index", ...telemetry, "--key", "received-at", "--type", "key", "--columns", "receivedAt", "--orders", "DESC"]);
  ensure("telemetry device index",
    ["tables-db", "get-index", ...telemetry, "--key", "device-id"],
    ["tables-db", "create-index", ...telemetry, "--key", "device-id", "--type", "unique", "--columns", "deviceId"]);
  ensure("telemetry HaLow MAC index",
    ["tables-db", "get-index", ...telemetry, "--key", "halow-mac"],
    ["tables-db", "create-index", ...telemetry, "--key", "halow-mac", "--type", "unique", "--columns", "halowMac"]);
  ensure("telemetry gateway device index",
    ["tables-db", "get-index", ...telemetry, "--key", "gateway-device-id"],
    ["tables-db", "create-index", ...telemetry, "--key", "gateway-device-id", "--type", "key", "--columns", "gatewayDeviceId"]);
  ensure("telemetry location spatial index",
    ["tables-db", "get-index", ...telemetry, "--key", "location-spatial"],
    ["tables-db", "create-index", ...telemetry, "--key", "location-spatial", "--type", "spatial", "--columns", "location"]);

  const otaUpdates = ["--database-id", config.databaseId, "--table-id", config.otaUpdateTableId];
  ensure("OTA updates table",
    ["tables-db", "get-table", ...otaUpdates],
    ["tables-db", "create-table", ...otaUpdates, "--name", "OTA updates", "--row-security", "true"]);
  run(["tables-db", "update-table", ...otaUpdates, "--name", "OTA updates", "--row-security", "true"]);
  for (const [key, size, required] of [
    ["deviceId", "36", true], ["serial", "36", true], ["requestId", "64", true],
    ["status", "16", true], ["detail", "256", false], ["firmwareVersion", "128", false],
    ["targetFirmwareVersion", "128", false], ["reportedAt", "40", true], ["completedAt", "40", false],
  ]) {
    const create = ["tables-db", "create-string-column", ...otaUpdates, "--key", key, "--size", size];
    if (required) create.push("--required", "true");
    ensure(`OTA updates.${key} column`,
      ["tables-db", "get-column", ...otaUpdates, "--key", key], create);
  }
  ensure("OTA request index",
    ["tables-db", "get-index", ...otaUpdates, "--key", "request-id"],
    ["tables-db", "create-index", ...otaUpdates, "--key", "request-id", "--type", "unique", "--columns", "requestId"]);
  ensure("OTA device time index",
    ["tables-db", "get-index", ...otaUpdates, "--key", "device-reported"],
    ["tables-db", "create-index", ...otaUpdates, "--key", "device-reported", "--type", "key", "--columns", "deviceId", "reportedAt", "--orders", "ASC", "DESC"]);

  const downlinks = ["--database-id", config.databaseId, "--table-id", config.downlinkTableId];
  ensure("downlinks table",
    ["tables-db", "get-table", ...downlinks],
    ["tables-db", "create-table", ...downlinks, "--name", "Companion downlinks", "--row-security", "true"]);
  run(["tables-db", "update-table", ...downlinks, "--name", "Companion downlinks", "--row-security", "true"]);
  for (const [key, size, required] of [
    ["deviceId", "36", true], ["serial", "36", true], ["gatewayDeviceId", "36", true],
    ["gatewaySerial", "36", true], ["requestId", "64", true], ["status", "16", true],
    ["detail", "256", false], ["reportedAt", "40", true], ["completedAt", "40", false],
  ]) {
    const create = ["tables-db", "create-string-column", ...downlinks, "--key", key, "--size", size];
    if (required) create.push("--required", "true");
    ensure(`downlinks.${key} column`,
      ["tables-db", "get-column", ...downlinks, "--key", key], create);
  }
  ensure("downlinks.revision column",
    ["tables-db", "get-column", ...downlinks, "--key", "revision"],
    ["tables-db", "create-integer-column", ...downlinks, "--key", "revision", "--min", "1", "--required", "true"]);
  ensure("downlinks request index",
    ["tables-db", "get-index", ...downlinks, "--key", "request-id"],
    ["tables-db", "create-index", ...downlinks, "--key", "request-id", "--type", "unique", "--columns", "requestId"]);
  ensure("downlinks device time index",
    ["tables-db", "get-index", ...downlinks, "--key", "device-reported"],
    ["tables-db", "create-index", ...downlinks, "--key", "device-reported", "--type", "key", "--columns", "deviceId", "reportedAt", "--orders", "ASC", "DESC"]);
  ensure("downlinks gateway status index",
    ["tables-db", "get-index", ...downlinks, "--key", "gateway-status"],
    ["tables-db", "create-index", ...downlinks, "--key", "gateway-status", "--type", "key", "--columns", "gatewayDeviceId", "status"]);

  const geofenceAreas = ["--database-id", config.databaseId, "--table-id", config.geofenceAreaTableId];
  ensure("geofence areas table",
    ["tables-db", "get-table", ...geofenceAreas],
    ["tables-db", "create-table", ...geofenceAreas, "--name", "Geofence areas", "--permissions", 'create("users")', "--row-security", "true"]);
  run(["tables-db", "update-table", ...geofenceAreas, "--permissions", 'create("users")', "--row-security", "true"]);
  for (const [key, size] of [["profileId", "36"], ["name", "128"], ["shape", "12"], ["geometry", "4000"]]) {
    ensure(`geofence areas.${key} column`,
      ["tables-db", "get-column", ...geofenceAreas, "--key", key],
      ["tables-db", "create-string-column", ...geofenceAreas, "--key", key, "--size", size, "--required", "true"]);
  }
  ensure("geofence areas profile index",
    ["tables-db", "get-index", ...geofenceAreas, "--key", "profile-id"],
    ["tables-db", "create-index", ...geofenceAreas, "--key", "profile-id", "--type", "key", "--columns", "profileId"]);

  const geofenceRules = ["--database-id", config.databaseId, "--table-id", config.geofenceRuleTableId];
  ensure("geofence rules table",
    ["tables-db", "get-table", ...geofenceRules],
    ["tables-db", "create-table", ...geofenceRules, "--name", "Geofence rules", "--permissions", 'create("users")', "--row-security", "true"]);
  run(["tables-db", "update-table", ...geofenceRules, "--permissions", 'create("users")', "--row-security", "true"]);
  for (const [key, size] of [["profileId", "36"], ["name", "128"], ["areaId", "36"]]) {
    ensure(`geofence rules.${key} column`,
      ["tables-db", "get-column", ...geofenceRules, "--key", key],
      ["tables-db", "create-string-column", ...geofenceRules, "--key", key, "--size", size, "--required", "true"]);
  }
  ensure("geofence rules.deviceIds column",
    ["tables-db", "get-column", ...geofenceRules, "--key", "deviceIds"],
    ["tables-db", "create-string-column", ...geofenceRules, "--key", "deviceIds", "--size", "36", "--array"]);
  for (const key of ["enterAlert", "exitAlert"]) {
    ensure(`geofence rules.${key} column`,
      ["tables-db", "get-column", ...geofenceRules, "--key", key],
      ["tables-db", "create-boolean-column", ...geofenceRules, "--key", key, "--required", "true"]);
  }
  ensure("geofence rules profile index",
    ["tables-db", "get-index", ...geofenceRules, "--key", "profile-id"],
    ["tables-db", "create-index", ...geofenceRules, "--key", "profile-id", "--type", "key", "--columns", "profileId"]);

  const alarms = ["--database-id", config.databaseId, "--table-id", config.geofenceAlarmTableId];
  ensure("geofence alarms table",
    ["tables-db", "get-table", ...alarms],
    ["tables-db", "create-table", ...alarms, "--name", "Geofence alarms", "--row-security", "true"]);
  run(["tables-db", "update-table", ...alarms, "--row-security", "true"]);
  for (const [key, size] of [["profileId", "36"], ["areaId", "36"], ["ruleId", "36"], ["deviceId", "36"], ["event", "8"], ["lastLocation", "128"], ["raisedAt", "40"]]) {
    ensure(`geofence alarms.${key} column`,
      ["tables-db", "get-column", ...alarms, "--key", key],
      ["tables-db", "create-string-column", ...alarms, "--key", key, "--size", size, "--required", "true"]);
  }
  for (const key of ["active", "acknowledged"]) {
    ensure(`geofence alarms.${key} column`,
      ["tables-db", "get-column", ...alarms, "--key", key],
      ["tables-db", "create-boolean-column", ...alarms, "--key", key, "--required", "true"]);
  }
  for (const key of ["clearedAt", "acknowledgedAt"]) {
    ensure(`geofence alarms.${key} column`,
      ["tables-db", "get-column", ...alarms, "--key", key],
      ["tables-db", "create-string-column", ...alarms, "--key", key, "--size", "40"]);
  }
  ensure("geofence alarms profile index",
    ["tables-db", "get-index", ...alarms, "--key", "profile-active"],
    ["tables-db", "create-index", ...alarms, "--key", "profile-active", "--type", "key", "--columns", "profileId", "active"]);
  ensure("geofence alarms rule device event index",
    ["tables-db", "get-index", ...alarms, "--key", "rule-device-event"],
    ["tables-db", "create-index", ...alarms, "--key", "rule-device-event", "--type", "unique", "--columns", "ruleId", "deviceId", "event"]);
}
