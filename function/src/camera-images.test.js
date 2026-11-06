import assert from "node:assert/strict";
import { test } from "node:test";
import { TablesDB, Storage } from "node-appwrite";
import { assembleCameraImage, cleanupCameraStaging, decodeCameraChunk, fnv1a32,
  IMAGE_TABLE, PART_TABLE, persistCameraChunk } from "./camera-images.js";

const jpeg = Buffer.from("FFD8FFC0000B0801E0028001011100FFD9", "hex");
const permissions = ['read("team:owner")'];
const err = (code) => Object.assign(new Error(String(code)), { code });
function frame(offset, data = jpeg.subarray(offset), session = 7, digest = fnv1a32(jpeg)) {
  const header = Buffer.alloc(52);
  Buffer.from("455a425404070401", "hex").copy(header);
  header.writeUInt32BE(session, 8); header.writeUInt32BE(jpeg.length, 12);
  header.writeUInt32BE(offset, 16); header.writeUInt32BE(digest, 20);
  header.writeUInt16BE(data.length, 28);
  return Buffer.concat([header, data]).toString("base64");
}
function harness() {
  const rows = new Map(), files = new Map();
  const key = (args) => `${args.tableId}/${args.rowId}`;
  const tables = {
    async createRow(args) {
      if (rows.has(key(args))) throw err(409);
      const row = { $id: args.rowId, $permissions: args.permissions, ...args.data };
      rows.set(key(args), row); return structuredClone(row);
    },
    async getRow(args) { if (!rows.has(key(args))) throw err(404); return structuredClone(rows.get(key(args))); },
    async updateRow(args) {
      const row = rows.get(key(args)); if (!row) throw err(404);
      Object.assign(row, args.data);
      if (args.permissions) row.$permissions = args.permissions;
      return structuredClone(row);
    },
    async deleteRow(args) { if (!rows.delete(key(args))) throw err(404); },
    async listRows(args) {
      let result = [...rows].filter(([id]) => id.startsWith(`${args.tableId}/`)).map(([, row]) => row);
      let limit = 25;
      result.sort((a, b) => a.$id.localeCompare(b.$id));
      for (const query of args.queries || []) {
        const q = JSON.parse(query);
        if (q.method === "equal") result = result.filter((row) => q.values.includes(row[q.attribute]));
        if (q.method === "lessThan") result = result.filter((row) => row[q.attribute] < q.values[0]);
        if (q.method === "cursorAfter") result = result.filter((row) => row.$id > q.values[0]);
        if (q.method === "limit") limit = q.values[0];
      }
      return { rows: structuredClone(result.slice(0, limit)) };
    },
  };
  const storage = {
    async createFile(args) {
      if (files.has(args.fileId)) throw err(409);
      files.set(args.fileId, args); return {};
    },
    async getFile(args) { if (!files.has(args.fileId)) throw err(404); return { sizeOriginal: jpeg.length }; },
    async deleteFile(args) { if (!files.delete(args.fileId)) throw err(404); },
  };
  const context = { tables, storage, databaseId: "db", target: { $id: "camera", serial: "ABC" },
    gateway: { $id: "gateway" }, permissions, encoding: "base64", now: "2026-11-06T00:00:00.000Z" };
  return { rows, files, context, send: (encoded) => persistCameraChunk({ ...context, encoded }) };
}

test("out-of-order chunks and MQTT redelivery produce one private JPEG", async () => {
  const h = harness();
  assert.equal((await h.send(frame(7))).complete, false);
  assert.equal(h.files.size, 0);
  const complete = await h.send(frame(0, jpeg.subarray(0, 7)));
  assert.equal(complete.complete, true);
  assert.equal(complete.width, 640); assert.equal(complete.height, 480);
  assert.equal(h.files.size, 1);
  assert.deepEqual([...h.files.values()][0].permissions, permissions);
  assert.deepEqual(h.rows.get(`${IMAGE_TABLE}/${complete.imageId}`).$permissions, permissions);
  assert.equal([...h.rows.keys()].filter((id) => id.startsWith(PART_TABLE)).length, 0);
  assert.equal((await h.send(frame(7))).complete, true);
  assert.equal(h.files.size, 1);
});

test("missing data, corrupt digest, invalid JPEG, and conflicting retries cannot create files", async () => {
  const h = harness();
  await h.send(frame(0, jpeg.subarray(0, 7)));
  assert.equal(h.files.size, 0);
  await assert.rejects(h.send(frame(0, Buffer.from("bad"))), /conflicts/);
  await assert.rejects(h.send(frame(0, jpeg, 8, 1)), /digest/);
  const invalidJpeg = Buffer.alloc(jpeg.length);
  await assert.rejects(h.send(frame(0, invalidJpeg, 9, fnv1a32(invalidJpeg))), /markers/);
  assert.equal(h.files.size, 0);
  assert.equal([...h.rows.values()].some((row) => row.status === "complete"), false);
});

test("session IDs isolate photos and staging rows grant no client access", async () => {
  const h = harness();
  await h.send(frame(0, jpeg.subarray(0, 7), 7));
  await h.send(frame(7, jpeg.subarray(7), 8));
  assert.equal(h.files.size, 0);
  for (const [id, row] of h.rows) if (id.startsWith(PART_TABLE)) assert.deepEqual(row.$permissions, []);
  await h.send(frame(7, jpeg.subarray(7), 7));
  assert.equal(h.files.size, 1);
});

test("a failed Storage upload remains retryable and is never listed as complete", async () => {
  const h = harness(), upload = h.context.storage.createFile;
  h.context.storage.createFile = async () => { throw err(503); };
  await assert.rejects(h.send(frame(0)), /503/);
  assert.equal([...h.rows.values()].some((row) => row.status === "complete"), false);
  h.context.storage.createFile = upload;
  assert.equal((await h.send(frame(0))).complete, true);
});

test("simultaneous finalizers store one photo", async () => {
  const h = harness();
  const results = await Promise.all([h.send(frame(0)), h.send(frame(0))]);
  assert.ok(results.every((result) => result.complete));
  assert.equal(h.files.size, 1);
});

test("parser bounds allocation and assembler rejects conflicting overlaps", () => {
  const oversized = Buffer.from(frame(0), "base64"); oversized.writeUInt32BE(524289, 12);
  assert.throws(() => decodeCameraChunk(oversized.toString("base64"), "base64"), /length/);
  assert.throws(() => decodeCameraChunk("A".repeat(2000), "base64"), /bounded/);
  assert.throws(() => assembleCameraImage({ totalBytes: jpeg.length, digest: "00000000" }, [
    { offset: 0, data: jpeg.toString("base64") }, { offset: 2, data: Buffer.from("bad").toString("base64") },
  ]), /conflicts/);
});

test("scheduled cleanup expires incomplete staging and retains completed photos", async () => {
  const h = harness();
  await h.send(frame(0, jpeg.subarray(0, 7), 7));
  const complete = await h.send(frame(0, jpeg, 8));
  assert.equal(await cleanupCameraStaging({ ...h.context, now: "2026-11-08T00:00:00.000Z" }), 1);
  assert.equal(h.rows.size, 1);
  assert.equal(h.rows.get(`${IMAGE_TABLE}/${complete.imageId}`).status, "complete");
  assert.equal(h.files.size, 1);
});

test("photos spanning multiple TablesDB pages assemble without truncation", async () => {
  const h = harness();
  const bytes = Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(125000, 0x42), jpeg.subarray(-2)]);
  let result;
  for (let offset = 0; offset < bytes.length; offset += 1100) {
    const header = Buffer.from(frame(0), "base64").subarray(0, 52);
    const data = bytes.subarray(offset, offset + 1100);
    header.writeUInt32BE(bytes.length, 12); header.writeUInt32BE(offset, 16);
    header.writeUInt32BE(fnv1a32(bytes), 20); header.writeUInt16BE(data.length, 28);
    result = await h.send(Buffer.concat([header, data]).toString("base64"));
  }
  assert.equal(result.complete, true);
  const saved = [...h.files.values()][0];
  assert.deepEqual(Buffer.from(await saved.file.arrayBuffer()), bytes);
});

test("MQTT camera route uses source Device ACLs and rejects an unrelated gateway scope", async () => {
  process.env.APPWRITE_FUNCTION_API_ENDPOINT = "https://example.test/v1";
  process.env.APPWRITE_FUNCTION_PROJECT_ID = "project";
  process.env.OFFGRID_TRACKER_DATABASE_ID = "db";
  process.env.OFFGRID_TRACKER_TELEMETRY_TABLE_ID = "telemetry";
  const { default: main } = await import("./main.js");
  const h = harness(), originals = [], originalFetch = globalThis.fetch;
  for (const [prototype, mocks] of [[TablesDB.prototype, h.context.tables], [Storage.prototype, h.context.storage]]) {
    for (const [method, mock] of Object.entries(mocks)) {
      originals.push([prototype, method, prototype[method]]); prototype[method] = mock;
    }
  }
  const gateway = { $id: "gateway", serial: "GW", $permissions: permissions, metadata: { profileId: "owner" } };
  const target = { $id: "camera", serial: "CAM", $permissions: permissions, metadata: { profileId: "owner" } };
  globalThis.fetch = async (url) => ({ ok: true, status: 200,
    json: async () => String(url).includes("queries[]") ? { devices: [target] } : gateway });
  const publish = (payload) => main({ req: { headers: {
    "x-appwrite-event": "devices.gateway.mqtt.message.publish", "x-appwrite-key": "server-key",
  }, bodyJson: { event: "message.publish", topic: "projects/project/devices/GW/telemetry/blocks/02:11:22:33:44:55",
    payload, payload_encoding: "base64" } },
  res: { json: (body, status) => ({ body, status }) }, error: (message) => { throw new Error(message); } });
  try {
    assert.equal((await publish(frame(0, jpeg.subarray(0, 7)))).status, 202);
    assert.equal((await publish(frame(7))).status, 201);
    assert.deepEqual([...h.files.values()][0].permissions, permissions);
    target.$permissions = ['read("team:someone-else")']; target.metadata.profileId = "someone-else";
    assert.equal((await publish(frame(0, jpeg, 99))).status, 403);
    assert.equal(h.files.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [prototype, method, original] of originals) prototype[method] = original;
  }
});
