import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";

// Binary payload carried inside MessageBody. Relays deliberately treat this as
// opaque data; only the factory X25519 identity named by `to` can open it.
export const provisioningEnvelopeMagic = Uint8Array.from([0x45, 0x5a, 0x50, 0x01]); // EZP v1

function concat(...arrays: Uint8Array[]) {
  const result = new Uint8Array(arrays.reduce((length, item) => length + item.length, 0));
  let offset = 0;
  for (const item of arrays) { result.set(item, offset); offset += item.length; }
  return result;
}

function littleInt64(value: bigint) {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigInt64(0, value, true);
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

function aad(from: bigint, to: bigint, nonce: Uint8Array) {
  const header = new Uint8Array(18);
  const view = new DataView(header.buffer);
  view.setBigInt64(0, from, true);
  view.setBigInt64(8, to, true);
  view.setUint16(16, nonce.length, true);
  return concat(header, nonce);
}

/** Encrypt an inner NetworkPacket with the SDK conversation-key construction. */
export function encryptProvisioningEnvelope({
  from,
  to,
  senderPrivateKey,
  senderPublicKey,
  recipientPublicKey,
  plaintext,
}: {
  from: bigint;
  to: bigint;
  senderPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  plaintext: Uint8Array;
}) {
  if (senderPrivateKey.length !== 32 || senderPublicKey.length !== 32 || recipientPublicKey.length !== 32) {
    throw new Error("Provisioning key pair is missing");
  }
  const shared = x25519.getSharedSecret(senderPrivateKey, recipientPublicKey);
  const senderIdentity = concat(littleInt64(from), senderPublicKey);
  const recipientIdentity = concat(littleInt64(to), recipientPublicKey);
  const senderFirst = from < to || (from === to && compareBytes(senderPublicKey, recipientPublicKey) <= 0);
  const key = sha256(concat(
    new TextEncoder().encode("EdgeZ conversation v1"),
    shared,
    senderFirst ? senderIdentity : recipientIdentity,
    senderFirst ? recipientIdentity : senderIdentity,
  ));
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce, aad(from, to, nonce)).encrypt(plaintext);
  return concat(provisioningEnvelopeMagic, senderPublicKey, nonce, ciphertext);
}
