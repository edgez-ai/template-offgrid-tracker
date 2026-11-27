import { Client, Models, Query, Storage } from "appwrite";

export const firmwareBucketId = "device-firmware";
export type Firmware = { id: string; name: string; target: "nrf54l15" | "heltec-hc33"; version: string; format: "hex" | "bin"; size: number; createdAt: string };
export function firmwareFromFile(file: Models.File): Firmware | null {
  const match = /^(nrf54l15|heltec-hc33)__([A-Za-z0-9][A-Za-z0-9.+-]{0,63})\.(hex|bin)$/.exec(file.name);
  if (!match || file.chunksUploaded !== file.chunksTotal) return null;
  return { id: file.$id, name: file.name, target: match[1] as Firmware["target"], version: match[2], format: match[3] as Firmware["format"], size: file.sizeOriginal, createdAt: file.$createdAt };
}
export function firmwareClient() {
  return new Client().setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!).setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!);
}
export async function listFirmware(): Promise<Firmware[]> {
  const storage = new Storage(firmwareClient());
  const result: Firmware[] = [];
  let cursor = "";
  do {
    const batch = await storage.listFiles({ bucketId: firmwareBucketId, queries: [Query.orderDesc("$createdAt"), Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
    for (const file of batch.files) {
      if (!file.$permissions.includes('read("any")')) continue;
      const firmware = firmwareFromFile(file);
      if (firmware) result.push(firmware);
    }
    cursor = batch.files.length === 100 ? batch.files.at(-1)!.$id : "";
  } while (cursor);
  return result;
}
