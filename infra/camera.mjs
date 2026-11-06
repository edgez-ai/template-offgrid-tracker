import { readFileSync } from "node:fs";
import path from "node:path";
import { config, dryRun, ensure, rootDir } from "./appwrite.mjs";

const plan = JSON.parse(readFileSync(path.join(rootDir, "appwrite.config.json"), "utf8"));

export async function installCamera() {
  for (const table of plan.tables.filter((item) => ["camera-images", "camera-image-parts"].includes(item.$id))) {
    const common = ["--database-id", config.databaseId, "--table-id", table.$id];
    ensure(`${table.$id} table`, ["tables-db", "get-table", ...common],
      ["tables-db", "create-table", ...common, "--name", table.name, "--row-security", "true"]);
    for (const column of table.columns) {
      const type = column.type === "varchar" ? "string" : column.type;
      const args = ["tables-db", `create-${type}-column`, ...common, "--key", column.key];
      if (column.required) args.push("--required", "true");
      if (column.size) args.push("--size", String(column.size));
      if (type === "integer") args.push("--min", String(column.min), "--max", String(column.max));
      ensure(`${table.$id}.${column.key}`, ["tables-db", "get-column", ...common, "--key", column.key], args);
    }
    for (const index of table.indexes) {
      const args = ["tables-db", "create-index", ...common, "--key", index.key, "--type", index.type,
        "--columns", ...index.attributes];
      if (index.orders) args.push("--orders", ...index.orders);
      ensure(`${table.$id}.${index.key}`, ["tables-db", "get-index", ...common, "--key", index.key], args);
    }
  }
  const bucket = plan.buckets.find((item) => item.$id === "camera-images");
  const { $id: bucketId, ...settings } = bucket;
  if (dryRun) {
    console.log(`[dry-run] reconcile private camera Storage bucket ${bucketId}`);
    return;
  }
  // Explicit JSON [] clears any existing bucket-wide grants. File read grants
  // are copied from each source Device by the Function.
  const request = async (suffix, method, body) => {
    const response = await fetch(`${config.endpoint.replace(/\/+$/, "")}/storage/buckets${suffix}`, {
      method, headers: { "content-type": "application/json", "x-appwrite-project": config.projectId,
        "x-appwrite-key": config.apiKey }, body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`Camera bucket ${method} failed (${response.status})`), { status: response.status });
  };
  try { await request("", "POST", { bucketId, ...settings }); }
  catch (error) { if (error.status !== 409) throw error; }
  await request(`/${bucketId}`, "PUT", settings);
}
