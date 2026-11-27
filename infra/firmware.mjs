import { readFileSync } from "node:fs";
import path from "node:path";
import { config, dryRun, rootDir } from "./appwrite.mjs";

export async function installFirmware() {
  const plan = JSON.parse(readFileSync(path.join(rootDir, "appwrite.config.json"), "utf8"));
  const { $id: bucketId, ...settings } = plan.buckets.find((item) => item.$id === "device-firmware");
  if (dryRun) return console.log(`[dry-run] reconcile firmware Storage bucket ${bucketId}`);
  const request = async (suffix, method, body) => {
    const response = await fetch(`${config.endpoint.replace(/\/+$/, "")}/storage/buckets${suffix}`, {
      method, headers: { "content-type": "application/json", "x-appwrite-project": config.projectId, "x-appwrite-key": config.apiKey }, body: JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`Firmware bucket ${method} failed (${response.status})`), { status: response.status });
  };
  try { await request("", "POST", { bucketId, ...settings }); }
  catch (error) { if (error.status !== 409) throw error; }
  // No project-wide read/write grants. Console admins publish individual files.
  await request(`/${bucketId}`, "PUT", settings);
}
