import { gatewayProductForModel, readGatewayClientIdentity, type GatewayClient, type GatewayProduct } from './gateway-lwm2m';
import { addDiscoveredProfileDevice, listProfileDevices } from './profile-store';

const serialKey = (value: string) => value.trim().toUpperCase();

/** Link the registration endpoint to a profile-local serial, never a remote name. */
export async function linkGatewayDevice(baseUrl: string, profileId: string, client: GatewayClient, signal?: AbortSignal) {
  const serial = serialKey(client.endpoint);
  const local = (await listProfileDevices(profileId)).find((device) => serialKey(device.serial) === serial);
  if (signal?.aborted) throw new Error('Gateway discovery cancelled.');
  if (local) {
    const type = local.deviceType?.trim().toLowerCase();
    const excluded = local.kind === 'h7608' || ['gateway', 'user', 'device_type_user', 'person', 'hiker', 'explorer'].includes(type);
    const product: GatewayProduct | null = type === 'camera' ? 'camera' : excluded ? null : 'collar';
    return { client: { ...client, serial: local.serial, name: local.name, localDeviceId: local.id, product }, added: false };
  }
  const identity = await readGatewayClientIdentity(baseUrl, client, signal);
  if (signal?.aborted) throw new Error('Gateway discovery cancelled.');

  const product = gatewayProductForModel(identity.model);
  // Retry incomplete identity reads on the next discovery instead of saving a
  // placeholder that would prevent the real name from being fetched later.
  if (!product || identity.name === undefined) return { client: { ...identity, serial }, added: false };
  const saved = await addDiscoveredProfileDevice({
    profileId, serial, name: identity.name.trim() || serial,
    kind: 'nrf54', firmwareTarget: 'nrf54l15', deviceType: product === 'camera' ? 'camera' : 'tracker',
    locationSource: 'none', latitude: null, longitude: null, marker: 'default',
    iconStyle: product === 'camera' ? 'camera' : 'tracker', userUuid: '', userPublicKey: '',
    lastSeenAt: '', meshMacAddress: serial,
  });
  return { client: { ...identity, serial: saved.serial, name: saved.name, localDeviceId: saved.id, product }, added: true };
}
