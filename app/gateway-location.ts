import { currentWifiGateway, executeGatewayResource } from './gateway-lwm2m';

/** One Execute starts acquisition and returns a fresh fix in a deferred response.
 * The device gets 295 seconds, leaving five seconds for transport in the REST
 * operation's 300-second deadline. No setup writes, polling or cached fix reads.
 */
export async function refreshGatewayLocation(endpoint: string, signal?: AbortSignal): Promise<{ latitude: number; longitude: number }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Location update timed out after 5 minutes.')); }, 300000);
    controller.signal.addEventListener('abort', () => reject(new Error(signal?.aborted ? 'Location request cancelled.' : 'Location update timed out after 5 minutes.')), { once: true });
  });
  const acquire = async () => {
    const url = await currentWifiGateway();
    if (controller.signal.aborted) throw new Error('Location request cancelled.');
    const content = await executeGatewayResource(url, endpoint, '/31028/0/0', controller.signal, 300, "0='295'");
    if (controller.signal.aborted) throw new Error('Location request cancelled.');
    if (content?.format !== 0 || typeof content.value !== 'string') {
      throw new Error('Update the gateway and device firmware to enable GPS Execute responses.');
    }
    let fix: { latitude?: unknown; longitude?: unknown; timestamp?: unknown };
    try { fix = JSON.parse(content.value); }
    catch { throw new Error('The device returned an invalid GPS response.'); }
    if (!fix || typeof fix.latitude !== 'number' || typeof fix.longitude !== 'number' ||
        !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude) ||
        Math.abs(fix.latitude) > 90 || Math.abs(fix.longitude) > 180 ||
        typeof fix.timestamp !== 'number' || !Number.isSafeInteger(fix.timestamp) || fix.timestamp <= 0) {
      throw new Error('The device returned invalid GPS coordinates or timestamp.');
    }
    return { latitude: fix.latitude, longitude: fix.longitude };
  };
  try { return await Promise.race([acquire(), timeout]); }
  finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); controller.abort(); }
}
