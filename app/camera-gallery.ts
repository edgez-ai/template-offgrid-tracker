import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import * as FileSystem from 'expo-file-system/legacy';
import type { GatewayPicture } from './gateway-camera';

export type GalleryPicture = GatewayPicture & { createdAt: number };
function directory(endpoint: string): string {
  if (!FileSystem.documentDirectory) throw new Error('App photo storage is unavailable.');
  if (!endpoint || endpoint.length > 200) throw new Error('Invalid camera endpoint.');
  return `${FileSystem.documentDirectory}camera-gallery/${bytesToHex(sha256(endpoint))}/`;
}
const filename = /^(\d+)-[a-z0-9]+\.jpg$/;

export async function listCameraPictures(endpoint: string): Promise<GalleryPicture[]> {
  const root = directory(endpoint);
  await FileSystem.makeDirectoryAsync(root, { intermediates: true });
  const names = (await FileSystem.readDirectoryAsync(root)).filter(name => filename.test(name));
  const entries = await Promise.all(names.map(async name => {
    const uri = root + name;
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory ? { uri, bytes: info.size, createdAt: Number(filename.exec(name)![1]) } : null;
  }));
  return entries.filter((entry): entry is GalleryPicture => entry !== null).sort((a, b) => b.createdAt - a.createdAt || b.uri.localeCompare(a.uri));
}

export async function storeCameraPicture(endpoint: string, picture: GatewayPicture): Promise<GalleryPicture> {
  const prefix = 'data:image/jpeg;base64,';
  if (!picture.uri.startsWith(prefix)) throw new Error('Invalid captured picture.');
  const root = directory(endpoint);
  await FileSystem.makeDirectoryAsync(root, { intermediates: true });
  const createdAt = Date.now();
  const uri = `${root}${createdAt}-${Math.random().toString(36).slice(2, 12)}.jpg`;
  const temporary = `${uri}.tmp`;
  try {
    await FileSystem.writeAsStringAsync(temporary, picture.uri.slice(prefix.length), { encoding: FileSystem.EncodingType.Base64 });
    await FileSystem.moveAsync({ from: temporary, to: uri });
    return { uri, bytes: picture.bytes, createdAt };
  } catch (error) {
    await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => {});
    throw error;
  }
}

export async function deleteCameraPicture(endpoint: string, uri: string): Promise<void> {
  const root = directory(endpoint);
  if (!uri.startsWith(root) || !filename.test(uri.slice(root.length))) throw new Error('Invalid gallery photo.');
  await FileSystem.deleteAsync(uri, { idempotent: true });
}
