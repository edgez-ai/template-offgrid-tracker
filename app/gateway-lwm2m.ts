import { NativeModules } from "react-native";

let nextRequestId = 0;
export async function currentWifiGateway(): Promise<string> {
  if (!NativeModules.WifiGateway) throw new Error("Rebuild the Android app to enable Wi-Fi gateway access.");
  return normalizeGatewayUrl(await NativeModules.WifiGateway.getGateway());
}
export type GatewayProduct = "collar" | "camera";
export type GatewayClient = { endpoint: string; lifetime?: number; registrationId?: string; model?: string; serial?: string; name?: string; localDeviceId?: string; product?: GatewayProduct | null };
export type GatewayResource = { kind?: string; id?: number; type?: string; value?: unknown; values?: Record<string, unknown> };

export function gatewayProductForModel(model?: string): GatewayProduct | null {
  switch (model?.trim().toUpperCase()) {
    case "EZ-DEV54-GPS": return "collar";
    case "EZ-DEV54-CAM": return "camera";
    default: return null;
  }
}

export async function readGatewayClientIdentity(baseUrl: string, client: GatewayClient, signal?: AbortSignal, fetchName = true): Promise<GatewayClient> {
  const [model, name] = await Promise.allSettled([
    readGatewayResource(baseUrl, client.endpoint, '/3/0/1', signal),
    fetchName ? readGatewayResource(baseUrl, client.endpoint, '/31029/0/7', signal) : Promise.resolve(undefined),
  ]);
  return {
    ...client,
    model: model.status === 'fulfilled' && typeof model.value.value === 'string' ? model.value.value : undefined,
    name: name.status === 'fulfilled' && typeof name.value?.value === 'string' ? name.value.value : undefined,
    serial: client.endpoint,
  };
}

export function normalizeGatewayUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error("Enter a gateway origin such as http://your-wifi-gateway:8088.");
  }
  return url.origin;
}

async function request(baseUrl: string, path: string, signal?: AbortSignal, operation?: { method: "PUT" | "POST"; body: string }): Promise<unknown> {
  const controller = new AbortController();
  const requestId = `gateway-${Date.now()}-${++nextRequestId}`;
  const abort = () => controller.abort();
  const cancel = () => NativeModules.WifiGateway?.cancelRequest(requestId);
  controller.signal.addEventListener('abort', cancel);
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort);
  const timeoutMatch = path.match(/[?&]timeout=(\d+)(?:&|$)/);
  const httpTimeoutMs = Math.max(8000, Number(timeoutMatch?.[1] ?? 5) * 1000 + 3000);
  const timer = setTimeout(abort, httpTimeoutMs);
  try {
    // Local gateway requests never carry Appwrite sessions or credentials.
    if (controller.signal.aborted) throw new Error("Gateway request cancelled.");
    if (!NativeModules.WifiGateway) throw new Error("Rebuild the Android app to enable Wi-Fi gateway access.");
    if (operation && !NativeModules.WifiGateway.requestOperation) throw new Error("Rebuild the Android app to enable GPS location requests.");
    const response = operation
      ? await NativeModules.WifiGateway.requestOperation(normalizeGatewayUrl(baseUrl), path, operation.method, operation.body, requestId)
      : await NativeModules.WifiGateway.request(normalizeGatewayUrl(baseUrl), path, requestId);
    if (controller.signal.aborted) throw new Error("Gateway request cancelled.");
    let data;
    try { data = JSON.parse(response.body); }
    catch { throw new Error("The Wi-Fi gateway did not return a LwM2M API response."); }
    if (response.status < 200 || response.status >= 300 || data?.success === false || data?.valid === false) {
      throw new Error(data?.error || data?.status || `Gateway request failed (${response.status}).`);
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("Gateway request timed out. Check the Wi-Fi connection.");
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function listGatewayClients(baseUrl: string, signal?: AbortSignal): Promise<GatewayClient[]> {
  const data = await request(baseUrl, '/clients', signal);
  if (!Array.isArray(data)) throw new Error('The gateway returned an invalid client list.');
  return data.filter((client): client is GatewayClient => typeof client?.endpoint === 'string' && client.endpoint.length > 0);
}

export async function readGatewayResource(baseUrl: string, endpoint: string, path: string, signal?: AbortSignal, timeoutSeconds = 5): Promise<GatewayResource> {
  if (!/^\/\d+\/\d+\/\d+$/.test(path)) throw new Error('Use a resource path such as /3/0/2.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("REST timeout must be 1–300 seconds.");
  const data = await request(baseUrl, `/clients/${encodeURIComponent(endpoint)}${path}?timeout=${timeoutSeconds}`, signal) as { success?: boolean; content?: GatewayResource };
  if (data.success !== true || !data.content) throw new Error('The gateway did not return a resource value.');
  return data.content;
}


export async function writeGatewayResource(baseUrl: string, endpoint: string, path: string, value: string, signal?: AbortSignal, timeoutSeconds = 5): Promise<void> {
  if (!/^\/\d+\/\d+\/\d+$/.test(path)) throw new Error('Invalid resource path.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("REST timeout must be 1–300 seconds.");
  const data = await request(baseUrl, `/clients/${encodeURIComponent(endpoint)}${path}?timeout=${timeoutSeconds}`, signal, { method: 'PUT', body: value }) as { success?: boolean };
  if (data.success !== true) throw new Error('The device did not confirm the resource write.');
}

export async function executeGatewayResource(baseUrl: string, endpoint: string, path: string, signal?: AbortSignal, timeoutSeconds = 5, args = ""): Promise<{ format?: number; value?: unknown } | undefined> {
  if (!/^\/\d+\/\d+\/\d+$/.test(path)) throw new Error('Invalid resource path.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error("REST timeout must be 1–300 seconds.");
  const data = await request(baseUrl, `/clients/${encodeURIComponent(endpoint)}${path}?timeout=${timeoutSeconds}`, signal, { method: 'POST', body: args }) as { success?: boolean; content?: { format?: number; value?: unknown } };
  if (data.success !== true) throw new Error('The device did not confirm the resource execution.');
  return data.content;
}
