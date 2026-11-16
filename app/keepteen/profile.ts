import { loadSharedProfileSettings, saveSharedProfileSettings } from "../app-settings";
import { activeProfile, createProfile } from "../profile-store";

/** Profiles remain a storage/runtime detail; KEEPTEEN opens on Devices. */
export async function ensureKeepteenProfile() {
  const current = await activeProfile();
  if (current) return current;

  const shared = await loadSharedProfileSettings();
  // A fresh network must not reconnect an old companion with default settings.
  const unpaired = { ...shared, bleDeviceId: "", bleDeviceName: "" };
  await saveSharedProfileSettings(unpaired);
  return createProfile({
    ...unpaired,
    name: "KEEPTEEN",
    country: "US",
    halowChannel: 27,
    meshId: "KEEPTEEN",
    meshPassphrase: "",
    connectToCloud: false,
  });
}
