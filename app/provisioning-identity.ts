import type { EdgezProvisioningDevice } from "@edgez/react-native-sdk";
import { prepareDeviceCredential, type PreparedDeviceCredential } from "./cloud-auth";
import { localMessageId } from "./mesh-utils";
import { listProfileDevices, type StoredProfile } from "./profile-store";

export type ProvisioningIdentity = Pick<PreparedDeviceCredential, "deviceId" | "clientId"> &
  Partial<Omit<PreparedDeviceCredential, "deviceId" | "clientId">>;

export async function prepareProvisioningIdentity(
  profile: StoredProfile,
  device: EdgezProvisioningDevice,
  name: string,
  markerColor: string,
  prepared: ProvisioningIdentity | null = null,
): Promise<ProvisioningIdentity> {
  if (!profile.connectToCloud) {
    const devices = await listProfileDevices(profile.id);
    const existing = devices.find((candidate) => candidate.serial.toUpperCase() === device.serial.toUpperCase());
    const deviceId = existing?.id ?? (prepared && !prepared.username ? prepared.deviceId : localMessageId().uuid);
    return { deviceId, clientId: deviceId };
  }
  if (prepared?.username) return prepared as PreparedDeviceCredential;
  return prepareDeviceCredential(
    profile.id, device.serial, name.trim() || device.serial, device.firmwareTarget,
    device.kind === "h7608", device.kind === "h7608" ? "gateway" : "sensor", markerColor,
  );
}
