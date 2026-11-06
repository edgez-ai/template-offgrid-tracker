import { createHash } from "node:crypto";
import { Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

export const IMAGE_TABLE = "camera-images";
export const PART_TABLE = "camera-image-parts";
export const IMAGE_BUCKET = "camera-images";
const MAX_IMAGE_BYTES = 512 * 1024;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const resolutions = new Set(["160x120", "320x240", "640x480", "1024x768", "1280x720",
  "1280x960", "1600x1200", "1920x1080", "2304x1296"]);
const idFor = (value) => createHash("sha256").update(value).digest("hex").slice(0, 36);
const codeOf = (error) => error?.code ?? error?.status;
const invalid = (message) => new Error(`Sensor block image ${message}`);

export function fnv1a32(bytes) {
  let digest = 0x811c9dc5;
  for (const byte of bytes) digest = Math.imul(digest ^ byte, 0x01000193) >>> 0;
  return digest;
}

export function isCameraChunk(encoded, encoding) {
  if (encoding !== "base64" || typeof encoded !== "string" || encoded.length > 1536) return false;
  const bytes = Buffer.from(encoded, "base64");
  return bytes.subarray(0, 4).toString("ascii") === "EZBT" && bytes[6] === 4;
}

export function decodeCameraChunk(encoded, encoding) {
  if (encoding !== "base64" || typeof encoded !== "string" || encoded.length > 1536 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw invalid("must be a bounded base64 payload");
  }
  const frame = Buffer.from(encoded, "base64");
  if (frame.length < 53 || frame.subarray(0, 5).toString("hex") !== "455a425404" ||
      frame[6] !== 4 || frame[7] !== 1 || frame[47] !== 0) throw invalid("header is invalid");
  const session = frame.readUInt32BE(8).toString(16).padStart(8, "0");
  const totalBytes = frame.readUInt32BE(12);
  const offset = frame.readUInt32BE(16);
  const digest = frame.readUInt32BE(20).toString(16).padStart(8, "0");
  const length = frame.readUInt16BE(28);
  if (totalBytes < 4 || totalBytes > MAX_IMAGE_BYTES || length < 1 || length > 1100 ||
      frame.length !== 52 + length || offset + length > totalBytes) throw invalid("length is invalid");
  return { session, totalBytes, offset, digest, data: frame.subarray(52) };
}

export function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid("JPEG markers are invalid");
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw invalid("JPEG marker stream is invalid");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid("JPEG segment is truncated");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw invalid("JPEG dimensions are truncated");
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (!resolutions.has(`${width}x${height}`)) throw invalid("resolution is unsupported");
      return { width, height };
    }
    offset += length;
  }
  throw invalid("JPEG dimensions are missing");
}

export function assembleCameraImage(image, parts) {
  const bytes = Buffer.alloc(image.totalBytes), covered = new Uint8Array(image.totalBytes);
  let count = 0;
  for (const part of parts) {
    const data = Buffer.from(part.data, "base64");
    if (!Number.isInteger(part.offset) || part.offset < 0 || part.offset + data.length > bytes.length) {
      throw invalid("stored part is out of bounds");
    }
    for (let i = 0; i < data.length; i++) {
      const index = part.offset + i;
      if (covered[index] && bytes[index] !== data[i]) throw invalid("retransmitted data conflicts");
      if (!covered[index]) { covered[index] = 1; count++; }
      bytes[index] = data[i];
    }
  }
  if (count !== bytes.length) return null;
  if (fnv1a32(bytes).toString(16).padStart(8, "0") !== image.digest) throw invalid("digest does not match");
  return { bytes, ...jpegDimensions(bytes) };
}

async function imageParts(tables, databaseId, imageId) {
  const parts = [];
  let cursor;
  do {
    const page = await tables.listRows({ databaseId, tableId: PART_TABLE, queries: [
      Query.equal("imageId", [imageId]), Query.orderAsc("$id"), Query.limit(100),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ] });
    parts.push(...page.rows);
    if (page.rows.length < 100) break;
    cursor = page.rows.at(-1).$id;
  } while (parts.length <= MAX_IMAGE_BYTES);
  return parts;
}

async function deleteParts(tables, databaseId, parts) {
  // Bound concurrent requests; another invocation may already have deleted a part.
  for (let offset = 0; offset < parts.length; offset += 16) {
    await Promise.all(parts.slice(offset, offset + 16).map(async (part) => {
      try { await tables.deleteRow({ databaseId, tableId: PART_TABLE, rowId: part.$id }); }
      catch (error) { if (codeOf(error) !== 404) throw error; }
    }));
  }
}

export async function persistCameraChunk({ tables, storage, databaseId, target, gateway,
  encoded, encoding, permissions, now = new Date().toISOString() }) {
  const chunk = decodeCameraChunk(encoded, encoding);
  const imageId = idFor(`${target.$id}:${chunk.session}:${chunk.totalBytes}:${chunk.digest}`);
  const row = { databaseId, tableId: IMAGE_TABLE, rowId: imageId };
  let image;
  const expiresAt = new Date(Date.parse(now) + STAGING_TTL_MS).toISOString();
  try {
    image = await tables.createRow({ ...row, permissions, data: {
      deviceId: target.$id, gatewayDeviceId: gateway.$id, serial: target.serial,
      session: chunk.session, totalBytes: chunk.totalBytes, digest: chunk.digest,
      receivedAt: now, expiresAt, status: "receiving", lastChunkSeen: false,
      width: 0, height: 0,
    } });
  } catch (error) {
    if (codeOf(error) !== 409) throw error;
    image = await tables.getRow(row);
  }
  if (image.status === "complete") return { imageId, complete: true };
  const partId = idFor(`${imageId}:${chunk.offset}`);
  try {
    await tables.createRow({ databaseId, tableId: PART_TABLE, rowId: partId, permissions: [],
      data: { imageId, offset: chunk.offset, data: chunk.data.toString("base64"), expiresAt } });
  } catch (error) {
    if (codeOf(error) !== 409) throw error;
    let existing;
    try { existing = await tables.getRow({ databaseId, tableId: PART_TABLE, rowId: partId }); }
    catch (readError) {
      // A parallel finalizer may have saved the file and removed staging.
      if (codeOf(readError) === 404 && (await tables.getRow(row)).status === "complete") {
        return { imageId, complete: true };
      }
      throw readError;
    }
    if (existing.data !== chunk.data.toString("base64")) throw invalid("retransmitted data conflicts");
  }
  if (chunk.offset + chunk.data.length === chunk.totalBytes) {
    // Update only the flag. A concurrent finalizer must never regress complete -> receiving.
    await tables.updateRow({ ...row, data: { lastChunkSeen: true } });
  }
  image = await tables.getRow(row);
  if (image.status === "complete") return { imageId, complete: true };
  if (!image.lastChunkSeen) return { imageId, complete: false };
  let parts;
  try { parts = await imageParts(tables, databaseId, imageId); }
  catch (error) {
    // A pagination cursor can disappear during a concurrent staging cleanup.
    if (codeOf(error) === 404 && (await tables.getRow(row)).status === "complete") {
      return { imageId, complete: true };
    }
    throw error;
  }
  const assembled = assembleCameraImage(image, parts);
  if (!assembled) return { imageId, complete: false };
  try {
    await storage.createFile({ bucketId: IMAGE_BUCKET, fileId: imageId,
      file: InputFile.fromBuffer(assembled.bytes, `${target.serial}-${chunk.session}.jpg`), permissions });
  } catch (error) {
    if (codeOf(error) !== 409) throw error;
    // Deterministic IDs make simultaneous finalizers and MQTT redelivery idempotent.
    const file = await storage.getFile({ bucketId: IMAGE_BUCKET, fileId: imageId });
    if (file.sizeOriginal !== image.totalBytes) throw invalid("stored file size conflicts");
  }
  await tables.updateRow({ ...row, permissions, data: {
    status: "complete", fileId: imageId, width: assembled.width, height: assembled.height,
  } });
  await deleteParts(tables, databaseId, parts);
  return { imageId, complete: true, width: assembled.width, height: assembled.height };
}

/** Scheduled, bounded cleanup of failed uploads; completed photos are retained. */
export async function cleanupCameraStaging({ tables, storage, databaseId, now = new Date().toISOString() }) {
  const expired = await tables.listRows({ databaseId, tableId: PART_TABLE,
    queries: [Query.lessThan("expiresAt", now), Query.limit(100)] });
  await deleteParts(tables, databaseId, expired.rows);
  const images = await tables.listRows({ databaseId, tableId: IMAGE_TABLE, queries: [
    Query.equal("status", ["receiving"]), Query.lessThan("expiresAt", now), Query.limit(10),
  ] });
  for (const image of images.rows) {
    const remaining = await tables.listRows({ databaseId, tableId: PART_TABLE,
      queries: [Query.equal("imageId", [image.$id]), Query.limit(1)] });
    if (remaining.rows.length) continue;
    try { await storage.deleteFile({ bucketId: IMAGE_BUCKET, fileId: image.$id }); }
    catch (error) { if (codeOf(error) !== 404) throw error; }
    await tables.deleteRow({ databaseId, tableId: IMAGE_TABLE, rowId: image.$id });
  }
  return expired.rows.length;
}
