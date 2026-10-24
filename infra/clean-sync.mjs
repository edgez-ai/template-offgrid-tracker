import {
  config,
  configureClient,
  dryRun,
  isMissing,
  removeResourceVariables,
  run,
} from "./appwrite.mjs";

function removeIfPresent(label, args) {
  if (dryRun) return run(args);
  const result = run(args, { capture: true, allowFailure: true });
  if (result.status === 0) return console.log(`Deleted ${label}`);
  if (isMissing(result)) return console.log(`Skipped missing ${label}`);
  process.stderr.write(`${result.stdout || ""}\n${result.stderr || ""}`);
  throw new Error(`Could not delete ${label}`);
}

configureClient();

for (const tableId of ["mobile-devices", "messages", "sensor-samples"]) {
  removeIfPresent(`${tableId} table`, [
    "tables-db", "delete-table", "--database-id", config.databaseId, "--table-id", tableId,
  ]);
}
removeIfPresent("message-attachments bucket", [
  "storage", "delete-bucket", "--bucket-id", "message-attachments",
]);
removeResourceVariables("functions", "--function-id", config.name, [
  "OFFGRID_TRACKER_PROFILE_TABLE_ID",
  "OFFGRID_TRACKER_MOBILE_DEVICE_TABLE_ID",
  "OFFGRID_TRACKER_MESSAGE_TABLE_ID",
  "OFFGRID_TRACKER_SENSOR_SAMPLE_TABLE_ID",
]);

console.log("Legacy mobile data-sync resources removed.");
