import { toByteArray } from 'base64-js';
import { currentWifiGateway, executeGatewayResource, readGatewayResource, writeGatewayResource } from './gateway-lwm2m';

export type GatewayPicture = { uri: string; bytes: number };

/** Capture powers the camera only for acquisition; the JPEG remains readable
 * while the camera is off. One deadline also bounds the blockwise image read. */
export async function captureGatewayPicture(endpoint: string, signal?: AbortSignal, onDownloading?: () => void): Promise<GatewayPicture> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Camera request timed out after 5 minutes.')); }, 300000);
    controller.signal.addEventListener('abort', () => reject(new Error(signal?.aborted ? 'Camera request cancelled.' : 'Camera request timed out after 5 minutes.')), { once: true });
  });
  const capture = async () => {
    const gateway = await currentWifiGateway();
    if (controller.signal.aborted) throw new Error('Camera request cancelled.');
    await executeGatewayResource(gateway, endpoint, '/5001/0/0', controller.signal, 30);
    if (controller.signal.aborted) throw new Error('Camera request cancelled.');
    onDownloading?.();
    const image = await readGatewayResource(gateway, endpoint, '/5001/0/1', controller.signal, 300);
    if (controller.signal.aborted) throw new Error('Camera request cancelled.');
    if (image.type !== 'OPAQUE' || typeof image.value !== 'string' || image.value.length > 349528 ||
        image.value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.value)) {
      throw new Error('The camera returned invalid image data.');
    }
    const bytes = toByteArray(image.value);
    if (bytes.length < 4 || bytes.length > 256 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error('The camera did not return a complete JPEG.');
    }
    return { uri: `data:image/jpeg;base64,${image.value}`, bytes: bytes.length };
  };
  try { return await Promise.race([capture(), timeout]); }
  finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export const CAMERA_RESOLUTIONS = ['640x480', '320x240', '160x120', '1024x768', '800x600', '1024x720'] as const;
export type CameraResolution = typeof CAMERA_RESOLUTIONS[number];

export async function readCameraResolution(endpoint: string, signal?: AbortSignal): Promise<CameraResolution> {
  const gateway = await currentWifiGateway();
  const result = await readGatewayResource(gateway, endpoint, '/5001/0/3', signal, 10);
  if (result.type !== 'STRING' || !CAMERA_RESOLUTIONS.includes(result.value as CameraResolution)) {
    throw new Error('The camera returned an unsupported resolution.');
  }
  return result.value as CameraResolution;
}

export async function changeCameraResolution(endpoint: string, resolution: CameraResolution, signal?: AbortSignal): Promise<CameraResolution> {
  if (!CAMERA_RESOLUTIONS.includes(resolution)) throw new Error('Unsupported camera resolution.');
  const gateway = await currentWifiGateway();
  await writeGatewayResource(gateway, endpoint, '/5001/0/3', resolution, signal, 10);
  const result = await readGatewayResource(gateway, endpoint, '/5001/0/3', signal, 10);
  if (result.type !== 'STRING' || result.value !== resolution) throw new Error('The camera did not confirm the selected resolution.');
  return resolution;
}
