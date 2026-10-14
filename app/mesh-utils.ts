import type { EdgezConversationMessage, EdgezMeshNode } from "@edgez/react-native-sdk";
import { toByteArray } from "base64-js";
import type { StoredDevice, StoredMessage } from "./profile-store";

export function coordinatesFromLocation(location: string) {
  const match = location.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

export function normalizedDeviceSerial(value: string) {
  return value.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

export function nodeNumFromSerial(value: string): bigint | null {
  const normalized = normalizedDeviceSerial(value);
  return normalized.length === 12 ? BigInt(`0x${normalized}`) : null;
}

export function storedDeviceNode(device: StoredDevice): EdgezMeshNode | null {
  const nodeNum = nodeNumFromSerial(device.meshMacAddress || device.serial);
  if (nodeNum === null || !device.userPublicKey) return null;
  const publicKey = toByteArray(device.userPublicKey);
  if (publicKey.length !== 32) return null;
  return {
    nodeNum,
    userUuid: device.userUuid,
    displayName: device.name,
    route: "CACHED",
    lastSeenMs: Date.parse(device.lastSeenAt) || 0,
    marker: "default",
    publicKey,
    latitude: device.latitude ?? undefined,
    longitude: device.longitude ?? undefined,
    deviceType: device.deviceType,
    geoFenceName: "",
    geoIndex: 0,
    sleeping: false,
    enabled: true,
  };
}

export function localMessageId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return {
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    high: BigInt(`0x${hex.slice(0, 16)}`),
    low: BigInt(`0x${hex.slice(16)}`),
  };
}

export function messagesByNode(messages: ReadonlyArray<StoredMessage>) {
  const conversations = new Map<bigint, EdgezConversationMessage[]>();
  for (const message of messages) {
    const nodeNum = nodeNumFromSerial(message.peerSerial);
    if (nodeNum === null) continue;
    conversations.set(nodeNum, [...conversations.get(nodeNum) ?? [], {
      nodeNum,
      text: message.text,
      mine: message.mine,
      timestampMs: message.timestampMs,
      messageUuid: message.messageUuid,
      status: message.status,
      voiceBytes: message.voiceBytes,
      voiceCodec: message.voiceCodec,
      durationMs: message.durationMs,
    }]);
  }
  return conversations;
}
