import { currentWifiGateway, executeGatewayResource, readGatewayResource, writeGatewayResource } from './gateway-lwm2m';

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Location request cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One deadline covers gateway discovery, GPS acquisition and coordinate reads. */
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
    const read = async (path: string) => {
      for (;;) {
        try { return await readGatewayResource(url, endpoint, path, controller.signal, 5); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!/timeout|timed out|not responding|retry in|503|5\.03|service unavailable|network|connect/i.test(message)) throw error;
          await pause(controller.signal);
        }
      }
    };
    const coordinates = async () => {
      const [lat, lon] = await Promise.all([
        read('/6/0/0'),
        read('/6/0/1'),
      ]);
      const latitude = Number(lat.value), longitude = Number(lon.value);
      if (lat.value === null || lon.value === null || lat.value === '' || lon.value === '' ||
          !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        throw new Error('The device returned invalid GPS coordinates.');
      }
      return { latitude, longitude };
    };
    const initialState = Number((await read('/31028/0/2')).value);
    if (!Number.isInteger(initialState) || initialState < 0 || initialState > 5) throw new Error('The device returned an invalid GPS state.');
    if (initialState === 2) {
      const ageValue = (await read('/31028/0/4')).value;
      const age = typeof ageValue === 'number' ? ageValue : typeof ageValue === 'string' && ageValue.trim() ? Number(ageValue) : NaN;
      // Repeated map opens must not power-cycle a receiver that just fixed.
      // Older fixes still require a fresh acquisition.
      if (Number.isFinite(age) && age >= 0 && age <= 5) return coordinates();
    }
    if (initialState !== 1) {
      try {
        await writeGatewayResource(url, endpoint, '/31028/0/1', '300', controller.signal, 300);
        await executeGatewayResource(url, endpoint, '/31028/0/0', controller.signal, 300);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // Another client may have started acquisition after the first read.
        // Join that request instead of retrying writes that firmware rejects.
        const state = Number((await read('/31028/0/2')).value);
        if (state !== 1) throw error;
      }
    }
    for (;;) {
      const state = Number((await read('/31028/0/2')).value);
      if (state === 2) break;
      if (state === 3) throw new Error('The device timed out acquiring a GPS location.');
      if (state === 4 || state === 5) throw new Error('The device could not acquire a GPS location.');
      if (state !== 1) throw new Error('The device did not start GPS acquisition.');
      await pause(controller.signal);
    }
    return coordinates();
  };
  try { return await Promise.race([acquire(), timeout]); }
  finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); controller.abort(); }
}
