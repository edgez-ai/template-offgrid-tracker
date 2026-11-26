import { useNetInfo } from '@react-native-community/netinfo';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { currentWifiGateway, listGatewayClients, type GatewayClient } from '../gateway-lwm2m';
import { linkGatewayDevice } from '../gateway-local-devices';
import type { KeepteenRuntime } from './types';

// Gateway discovery changes the existing product data, without adding home UI.
export function useGatewayDevices(runtime: KeepteenRuntime, onDevicesChanged: () => Promise<void>) {
  const network = useNetInfo();
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const changed = useRef(onDevicesChanged);
  changed.current = onDevicesChanged;
  const [state, setState] = useState<{ profileId: string; clients: GatewayClient[]; connected: boolean }>({ profileId: '', clients: [], connected: false });
  useEffect(() => {
    if (runtime.onlineMode) return;
    const controller = new AbortController();
    let inFlight: Promise<void> | null = null;
    const run = async () => {
      try {
        const url = await currentWifiGateway();
        const clients = await listGatewayClients(url, controller.signal);
        const identified: GatewayClient[] = [];
        let added = false;
        for (const client of clients) {
          if (controller.signal.aborted) return;
          const linked = await linkGatewayDevice(url, runtime.profile.id, client, controller.signal);
          identified.push(linked.client);
          added ||= linked.added;
        }
        if (added && !controller.signal.aborted) await changed.current();
        if (!controller.signal.aborted) setState({ profileId: runtime.profile.id, clients: identified, connected: true });
      } catch {
        if (!controller.signal.aborted) setState({ profileId: runtime.profile.id, clients: [], connected: false });
      }
    };
    // Manual and periodic refreshes share one request, including its completion.
    const performRefresh = () => {
      if (controller.signal.aborted) return Promise.resolve();
      if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
      return inFlight;
    };
    refreshRef.current = performRefresh;
    void performRefresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void performRefresh(); }, 15000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void performRefresh(); });
    return () => {
      controller.abort(); clearInterval(timer); subscription.remove();
      if (refreshRef.current === performRefresh) refreshRef.current = async () => {};
    };
  }, [runtime.profile.id, runtime.onlineMode, network.type, network.isConnected,
    network.details && 'ipAddress' in network.details ? network.details.ipAddress : null]);
  const active = !runtime.onlineMode && state.profileId === runtime.profile.id;
  return { clients: active ? state.clients : [], connected: active ? state.connected : undefined, refresh };
}
