import { decodeNetworkPacket, Operation } from "@edgez/react-native-sdk";
import { fromByteArray } from "base64-js";
import type { ProvisioningRequestDetails } from "./profile-store";

type ProtocolObject = Record<string, unknown>;

function unframe(raw: Uint8Array) {
  if (raw.length < 4 || raw[0] !== 0x45 || raw[1] !== 0x5a) return raw;
  const length = raw[2]! | (raw[3]! << 8);
  return length <= 512 && raw.length >= length + 4 ? raw.slice(4, length + 4) : raw;
}

function integerString(value: unknown) {
  try { return BigInt(String(value ?? 0)).toString(); } catch { return "0"; }
}

function bytes(value: unknown) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array();
}

function usableSensorSerial(value: unknown) {
  if (typeof value !== "string") return "";
  const serial = value.trim();
  return serial && serial.toLowerCase() !== "edgez user" ? serial : "";
}

export function provisioningRequestFromPacket(
  profileId: string,
  raw: Uint8Array,
): ProvisioningRequestDetails | null {
  let packet: ProtocolObject;
  try { packet = decodeNetworkPacket(unframe(raw)) as ProtocolObject; } catch { return null; }
  const settings = packet.deviceSettings as ProtocolObject | undefined;
  const nodeNum = integerString(packet.from);
  const publicKey = bytes(settings?.userPublicKey);
  if (Number(packet.operation) !== Operation.request || !settings ||
      Number(settings.action) !== 3 || Number(settings.deviceType) !== 5 ||
      nodeNum === "0" || publicKey.length !== 32) return null;
  const fallbackSerial = BigInt(nodeNum).toString(16).padStart(12, "0").toUpperCase();
  const serial = usableSensorSerial(settings.userName) || fallbackSerial;
  return {
    profileId,
    serial,
    nodeNum,
    userIdHigh: integerString(settings.userIdHigh),
    userIdLow: integerString(settings.userIdLow),
    userPublicKey: fromByteArray(publicKey),
    lastSeenAt: new Date().toISOString(),
  };
}

export function provisioningNodeAddress(nodeNum: string) {
  try { return BigInt(nodeNum).toString(16).padStart(12, "0").toUpperCase(); }
  catch { return nodeNum; }
}

function readVarint(bytes: Uint8Array, offset: number) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length && shift <= 63) {
    const byte = bytes[cursor++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new Error("Invalid provisioning protobuf varint.");
}

function encodeVarint(value: number) {
  const encoded: number[] = [];
  let remaining = value >>> 0;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    encoded.push(remaining ? byte | 0x80 : byte);
  } while (remaining);
  return Uint8Array.from(encoded);
}

function appendNestedFields(packet: Uint8Array, outerField: number, fields: Uint8Array[]) {
  let cursor = 0;
  while (cursor < packet.length) {
    const key = readVarint(packet, cursor);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    cursor = key.next;
    if (wire === 0) {
      cursor = readVarint(packet, cursor).next;
    } else if (wire === 1) {
      cursor += 8;
    } else if (wire === 2) {
      const lengthOffset = cursor;
      const length = readVarint(packet, cursor);
      const payloadStart = length.next;
      const payloadEnd = payloadStart + length.value;
      if (payloadEnd > packet.length) throw new Error("Invalid provisioning protobuf length.");
      if (field === outerField) {
        const extensionLength = fields.reduce((sum, item) => sum + item.length, 0);
        const encodedLength = encodeVarint(length.value + extensionLength);
        const updated = new Uint8Array(packet.length - (payloadStart - lengthOffset) + encodedLength.length + extensionLength);
        let output = 0;
        updated.set(packet.slice(0, lengthOffset), output); output += lengthOffset;
        updated.set(encodedLength, output); output += encodedLength.length;
        updated.set(packet.slice(payloadStart, payloadEnd), output); output += length.value;
        for (const extension of fields) {
          updated.set(extension, output);
          output += extension.length;
        }
        updated.set(packet.slice(payloadEnd), output);
        return updated;
      }
      cursor = payloadEnd;
    } else if (wire === 5) {
      cursor += 4;
    } else {
      throw new Error("Unsupported provisioning protobuf wire type.");
    }
  }
  throw new Error("Packet does not contain the expected profile body.");
}

function protobufString(field: number, value: string) {
  const data = new TextEncoder().encode(value);
  const key = encodeVarint((field << 3) | 2);
  const length = encodeVarint(data.length);
  const output = new Uint8Array(key.length + length.length + data.length);
  output.set(key, 0);
  output.set(length, key.length);
  output.set(data, key.length + length.length);
  return output;
}

/** Adds fields introduced after SDK 0.1.33 without modifying the SDK. */
export function applyProvisionedProfileExtensions(packet: Uint8Array, options: {
  deviceGpsEnabled: boolean;
  iconStyle: string;
}) {
  const fields = [protobufString(21, options.iconStyle)];
  if (options.deviceGpsEnabled) fields.unshift(Uint8Array.from([0xa0, 0x01, 0x01]));
  return appendNestedFields(packet, 103, fields);
}

export function applyDeviceSettingsIcon(packet: Uint8Array, iconStyle: string) {
  return appendNestedFields(packet, 104, [protobufString(29, iconStyle)]);
}

const beaconIcons = new Map<string, string>();

function findLengthDelimited(bytes: Uint8Array, wantedField: number) {
  let cursor = 0;
  while (cursor < bytes.length) {
    const key = readVarint(bytes, cursor);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    cursor = key.next;
    if (wire === 0) cursor = readVarint(bytes, cursor).next;
    else if (wire === 1) cursor += 8;
    else if (wire === 2) {
      const length = readVarint(bytes, cursor);
      const end = length.next + length.value;
      if (end > bytes.length) return null;
      if (field === wantedField) return bytes.slice(length.next, end);
      cursor = end;
    } else if (wire === 5) cursor += 4;
    else return null;
  }
  return null;
}

function findVarint(bytes: Uint8Array, wantedField: number) {
  let cursor = 0;
  while (cursor < bytes.length) {
    const key = readVarint(bytes, cursor);
    const field = key.value >>> 3;
    const wire = key.value & 7;
    cursor = key.next;
    if (wire === 0) {
      const value = readVarint(bytes, cursor);
      if (field === wantedField) return value.value;
      cursor = value.next;
    } else if (wire === 1) cursor += 8;
    else if (wire === 2) {
      const length = readVarint(bytes, cursor);
      cursor = length.next + length.value;
    } else if (wire === 5) cursor += 4;
    else return null;
  }
  return null;
}

export function rememberBeaconIconFromPacket(raw: Uint8Array) {
  try {
    const packet = unframe(raw);
    const beacon = findLengthDelimited(packet, 106);
    const nodeNum = findVarint(packet, 1);
    const encodedIcon = beacon ? findLengthDelimited(beacon, 11) : null;
    if (!nodeNum || !encodedIcon?.length) return;
    const icon = new TextDecoder().decode(encodedIcon);
    if (icon) beaconIcons.set(BigInt(nodeNum).toString(), icon);
  } catch {
    // New metadata is optional; malformed/legacy packets continue through SDK decoding.
  }
}

export function rememberedBeaconIcon(nodeNum: bigint) {
  return beaconIcons.get(nodeNum.toString());
}
