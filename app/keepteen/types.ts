import type { EdgezMeshSession, EdgezMeshState, EdgezSensorSample } from "@edgez/react-native-sdk";
import type { BleLinkStatus } from "../ActiveProfileBleLink";
import type { SharedProfileSettings } from "../app-settings";
import type { CloudConnectionState } from "../cloud-auth";
import type { StoredDevice, StoredMessage, StoredProfile, StoredProvisioningRequest } from "../profile-store";

/** Everything the KEEPTEEN shell needs from the existing App.tsx runtime. */
export type KeepteenRuntime = {
  profile: StoredProfile;
  profiles: StoredProfile[];
  sharedSettings: SharedProfileSettings;
  devices: StoredDevice[];
  messages: StoredMessage[];
  provisioningRequests: StoredProvisioningRequest[];
  cloudSensorSamples: EdgezSensorSample[];
  /** Profile has "Connect to cloud" enabled: data comes from Appwrite, not BLE. */
  onlineMode: boolean;
  bleStatus: BleLinkStatus;
  /** Current Wi-Fi gateway API reachability for offline device products. */
  gatewayConnected?: boolean;
  gatewayRegisteredSerials?: readonly string[];
  cloudStatus: CloudConnectionState;
  cloudLoggedIn: boolean;
  meshLink: { session: EdgezMeshSession; state: EdgezMeshState } | null;
  busy: boolean;
  error: string;
};

export type KeepteenActions = {
  removeDevice: (device: StoredDevice) => void;
  messagesChanged: () => Promise<void>;
  devicesChanged: () => Promise<void>;
  provisioningRequestsChanged: () => Promise<void>;
  resendMessage: (message: StoredMessage) => Promise<void>;
  addDevice: () => void;
  cloudAuthenticated: () => void;
  cloudLogout: () => void;
  selectProfile: (profile: StoredProfile) => void;
  createProfile: () => void;
  editProfile: () => void;
  deleteProfile: () => void;
  saveSharedSettings: (settings: SharedProfileSettings) => Promise<void>;
  /** Opens the original detailed settings page (identity, beacon, location, BLE device). */
  openAdvancedSettings: () => void;
};
