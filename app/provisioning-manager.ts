import {
  EdgezNativeTransport,
  EdgezProvisioningManager,
  type EdgezProvisioningConfig,
  type EdgezProvisioningDevice,
  type EdgezProvisioningKind,
  type EdgezProvisioningInput,
  type EdgezProvisioningResult,
  type EdgezProvisioningScanOptions,
  type EdgezProvisioningScanResult,
} from "@edgez/react-native-sdk";
import { ESPDevice, ESPProvisionManager, ESPSecurity, ESPTransport } from "@orbital-systems/react-native-esp-idf-provisioning";
import { PermissionsAndroid, Platform, type Permission } from "react-native";

// All BLE targets share ESP-IDF Security 1; cameras use standard Wi-Fi
// configuration, while tracker boards expose mqtt-config.
class ProvisioningDevice implements EdgezProvisioningDevice {
  readonly id: string;
  readonly name: string;
  readonly serial: string;
  readonly transport: "ble" | "softap";
  category: "tracker" | "gateway";
  firmwareTarget: string;
  readonly requiresProofOfPossession = true;
  readonly requiresDeviceName: boolean;
  readonly deviceNameMaxLength: number;
  supportsUpstreamWifi: boolean;
  supportsDeviceGps: boolean;
  standardWifiProvisioning: boolean;
  private supportsMqttConfig = false;
  provisioningName?: string;

  constructor(private readonly device: ESPDevice, public kind: EdgezProvisioningKind, serial: string) {
    this.id = this.name = device.name;
    this.standardWifiProvisioning = /^PROV_CAM[A-F0-9]{6}$/i.test(device.name);
    this.serial = serial.toUpperCase();
    this.transport = kind === "h7608" ? "softap" : "ble";
    this.category = kind === "nrf54" ? "tracker" : "gateway";
    this.firmwareTarget = kind === "nrf54" ? "nrf54l15" : kind === "h7608" ? "heltec-h7608-v1" : "heltec-hc33";
    this.requiresDeviceName = kind === "h7608";
    this.deviceNameMaxLength = kind === "h7608" ? 32 : 128;
    this.supportsUpstreamWifi = kind !== "nrf54" || this.standardWifiProvisioning;
    this.supportsDeviceGps = kind === "nrf54" && !this.standardWifiProvisioning;
  }

  async connect(pop?: string): Promise<void> {
    const secret = pop?.trim();
    if (!secret) throw new Error("A provisioning password is required.");
    if (this.transport === "softap") await this.device.connect(null, secret, null);
    else await this.device.connect(secret, null, null);
    if (this.transport === "ble") {
      const capabilities = await this.device.getDeviceCapabilities();
      this.supportsMqttConfig = capabilities?.includes("mqtt_config") ?? false;
      if (capabilities?.includes("ez_wifi_prov")) {
        this.standardWifiProvisioning = true;
        this.kind = "nrf54";
        this.category = "tracker";
        this.firmwareTarget = "nrf54l15";
        this.supportsUpstreamWifi = true;
        this.supportsDeviceGps = false;
      }
    }
  }

  async configure(config: EdgezProvisioningConfig): Promise<EdgezProvisioningResult> {
    config = { ...config, deviceName: this.provisioningName || config.deviceName || this.serial };
    if (this.standardWifiProvisioning) {
      if (this.supportsMqttConfig) {
        const name = config.deviceName?.trim() || this.serial;
        if (encodeURIComponent(name).replace(/%[A-F\d]{2}/gi, 'x').length > 128) throw new Error("Device name must not exceed 128 UTF-8 bytes.");
        const saved = JSON.parse(await this.device.sendData("mqtt-config", JSON.stringify({ ...config, deviceName: name }))) as EdgezProvisioningResult;
        if (!saved.ok || !saved.persisted) throw new Error("The device did not save its name.");
      }
      const result = await this.device.provision(config.meshId, config.passphrase);
      if (result.status !== "success") throw new Error("The device did not confirm network provisioning.");
      return { ok: true, persisted: true };
    }
    const payload = JSON.stringify(config);
    const response = this.transport === "softap" && Platform.OS === "android"
      ? await new EdgezNativeTransport().invoke<string>("sendH7608CustomEndpoint", { endpoint: "mqtt-config", data: payload })
      : await this.device.sendData("mqtt-config", payload);
    const result = JSON.parse(response) as EdgezProvisioningResult;
    return { ...result, persisted: result.persisted ?? result.ok };
  }

  async scanUpstreamWifi() {
    return this.supportsUpstreamWifi ? this.device.scanWifiList() : [];
  }

  async provisionUpstreamWifi(ssid: string, passphrase: string): Promise<void> {
    if (!this.supportsUpstreamWifi) throw new Error("The nRF54 does not support upstream Wi-Fi.");
    await this.device.provision(ssid, passphrase);
  }

  async disconnect(): Promise<void> {
    this.device.disconnect();
  }
}

export class ProvisioningManager extends EdgezProvisioningManager {
  override configure(device: EdgezProvisioningDevice, input: EdgezProvisioningInput): Promise<EdgezProvisioningResult> {
    // The SDK currently only copies deviceName for nRF54; preserve it for every target.
    if (device instanceof ProvisioningDevice) device.provisioningName = input.deviceName?.trim() || device.serial;
    return super.configure(device, input);
  }

  override async scan(options: EdgezProvisioningScanOptions = {}): Promise<EdgezProvisioningScanResult> {
    await requestPermissions();
    const esp32Prefix = options.esp32BlePrefix ?? "PROV_";
    if (!esp32Prefix) throw new Error("ESP32 BLE provisioning prefix must not be empty.");
    const devices: EdgezProvisioningDevice[] = [];
    const warnings: string[] = [];
    // The native provisioning library owns one scanner; scan sequentially.
    const scans = [
      { prefix: esp32Prefix, kind: "esp32", transport: ESPTransport.ble },
      { prefix: "NRF_", kind: "nrf54", transport: ESPTransport.ble },
      { prefix: "PROV_", kind: "esp32", transport: ESPTransport.ble },
      { prefix: "PROV_", kind: "h7608", transport: ESPTransport.softap },
    ] as const;
    for (const scan of scans) {
      if (scans.findIndex((candidate) => candidate.prefix === scan.prefix && candidate.transport === scan.transport) !== scans.indexOf(scan)) continue;
      try {
        const discovered = await ESPProvisionManager.searchESPDevices(
          scan.prefix, scan.transport,
          scan.transport === ESPTransport.ble ? ESPSecurity.secure : ESPSecurity.unsecure,
        );
        for (const device of discovered) {
          if (!device.name.toLowerCase().startsWith(scan.prefix.toLowerCase())) continue;
          // Camera names contain a model tag before the factory identity hash.
          const camera = scan.transport === ESPTransport.ble && /^PROV_CAM[A-F0-9]{6}$/i.test(device.name);
          const serial = device.name.slice(camera ? "PROV_CAM".length : scan.prefix.length);
          if (!/^[A-F0-9]{6,12}$/i.test(serial)) continue;
          devices.push(new ProvisioningDevice(device, camera ? "nrf54" : scan.kind, serial));
        }
      } catch (error) {
        if (!/no (?:bluetooth|wi-?fi) device found with given prefix/i.test(String(error))) {
          warnings.push(`${scan.kind} ${scan.transport} scan: ${String(error)}`);
        }
      }
    }
    return { devices, warnings };
  }
}

async function requestPermissions(): Promise<void> {
  if (Platform.OS !== "android") return;
  const permissions: Permission[] = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  if (Number(Platform.Version) >= 31) {
    permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  }
  if (Number(Platform.Version) >= 33) permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
  const missing: Permission[] = [];
  for (const permission of permissions) {
    if (!await PermissionsAndroid.check(permission)) missing.push(permission);
  }
  if (!missing.length) return;
  const results = await PermissionsAndroid.requestMultiple(missing);
  if (missing.some((permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new Error("Bluetooth and nearby Wi-Fi permissions are required to discover provisioning devices.");
  }
}
