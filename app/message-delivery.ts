import { edgezNodeId, isEdgezPublicChannel } from "@edgez/react-native-sdk";
import type { EdgezMeshSession, EdgezMeshState } from "@edgez/react-native-sdk";
import { useCallback, useEffect, useRef } from "react";
import { nodeNumFromSerial, normalizedDeviceSerial } from "./mesh-utils";
import {
  listProfileMessages,
  reconcileProfileMessageDelivery,
  saveProfileMessage,
  updateMessageDelivery,
} from "./profile-store";
import type { StoredDevice, StoredMessage } from "./profile-store";

export const PEER_ONLINE_WINDOW_MS = 120_000;
const DELIVERY_ACK_TIMEOUT_MS = 15_000;
const DELIVERY_CHECK_INTERVAL_MS = 5_000;
const MAX_AUTO_RETRIES = 3;

export function displayedMessageStatus(message: StoredMessage) {
  return message.deliveryState || message.status || (message.mine ? "Sending" : "");
}

export function peerLastSeenMs(
  serial: string,
  devices: ReadonlyArray<StoredDevice>,
  meshState: EdgezMeshState | null,
) {
  const normalized = normalizedDeviceSerial(serial);
  const device = devices.find((item) =>
    normalizedDeviceSerial(item.meshMacAddress || item.serial) === normalized);
  const nodeNum = nodeNumFromSerial(serial);
  const liveLastSeen = nodeNum === null ? 0 : meshState?.nodes.get(nodeNum)?.lastSeenMs ?? 0;
  return Math.max(liveLastSeen, device ? Date.parse(device.lastSeenAt) || 0 : 0);
}

export function isPeerOnline(
  serial: string,
  devices: ReadonlyArray<StoredDevice>,
  meshState: EdgezMeshState | null,
  now = Date.now(),
) {
  const nodeNum = nodeNumFromSerial(serial);
  const liveNode = nodeNum === null ? undefined : meshState?.nodes.get(nodeNum);
  return Boolean(
    liveNode
    && liveNode.route !== "CACHED"
    && liveNode.lastSeenMs > 0
    && now - liveNode.lastSeenMs <= PEER_ONLINE_WINDOW_MS,
  );
}

export function useMessageDeliveryRetries({
  profileId,
  session,
  meshState,
  devices,
  onMessagesChanged,
}: {
  profileId: string | null;
  session: EdgezMeshSession | null;
  meshState: EdgezMeshState | null;
  devices: ReadonlyArray<StoredDevice>;
  onMessagesChanged: () => Promise<void>;
}) {
  const checking = useRef(false);
  const retrying = useRef(new Set<string>());

  const retryMessage = useCallback(async (message: StoredMessage, resetCycle = false) => {
    if (!profileId || !session || !meshState?.bleReady) throw new Error("BLE control channel is not ready.");
    const nodeNum = nodeNumFromSerial(message.peerSerial);
    if (nodeNum === null || isEdgezPublicChannel(nodeNum)) throw new Error("This message cannot be retried.");
    if (!isPeerOnline(message.peerSerial, devices, meshState)) throw new Error("The peer is offline. Retry when a fresh beacon is received.");
    if (retrying.current.has(message.messageUuid)) return;

    const retryCount = resetCycle ? 1 : message.retryCount + 1;
    const attemptedAt = Date.now();
    retrying.current.add(message.messageUuid);
    try {
      await updateMessageDelivery(profileId, message.messageUuid, {
        retryCount,
        lastAttemptAtMs: attemptedAt,
        deliveryState: `Retrying ${retryCount}/${MAX_AUTO_RETRIES}`,
      });
      await onMessagesChanged();
      const sent = await session.sendTextMessage(nodeNum, message.text);
      await saveProfileMessage(profileId, edgezNodeId(nodeNum).toUpperCase(), sent, {
        retryOfUuid: message.messageUuid,
        lastAttemptAtMs: attemptedAt,
      });
    } finally {
      retrying.current.delete(message.messageUuid);
      await onMessagesChanged();
    }
  }, [devices, meshState, onMessagesChanged, profileId, session]);

  useEffect(() => {
    if (!profileId || !session || !meshState?.bleReady) return;
    let cancelled = false;

    const check = async () => {
      if (cancelled || checking.current) return;
      checking.current = true;
      try {
        const reconciled = await reconcileProfileMessageDelivery(profileId);
        const messages = await listProfileMessages(profileId);
        const now = Date.now();
        let changed = reconciled;
        for (const message of messages) {
          if (!message.mine || message.retryOfUuid || displayedMessageStatus(message) === "Delivered") continue;
          const nodeNum = nodeNumFromSerial(message.peerSerial);
          if (nodeNum === null || isEdgezPublicChannel(nodeNum)) continue;
          const lastAttempt = message.lastAttemptAtMs || message.timestampMs;
          if (now - lastAttempt < DELIVERY_ACK_TIMEOUT_MS) continue;
          if (message.retryCount >= MAX_AUTO_RETRIES) {
            if (message.deliveryState !== "Failed") {
              await updateMessageDelivery(profileId, message.messageUuid, {
                retryCount: message.retryCount,
                lastAttemptAtMs: lastAttempt,
                deliveryState: "Failed",
              });
              changed = true;
            }
            continue;
          }
          if (!isPeerOnline(message.peerSerial, devices, meshState, now)) continue;
          try {
            await retryMessage(message);
          } catch {
            // A transport failure still consumes this retry. The next check
            // either tries again or marks the logical message failed.
          }
          changed = true;
        }
        if (changed && !cancelled) await onMessagesChanged();
      } finally {
        checking.current = false;
      }
    };

    void check();
    const timer = setInterval(() => void check(), DELIVERY_CHECK_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [devices, meshState, onMessagesChanged, profileId, retryMessage, session]);

  const resendMessage = useCallback(async (message: StoredMessage) => {
    await retryMessage(message, true);
  }, [retryMessage]);

  return { resendMessage };
}
