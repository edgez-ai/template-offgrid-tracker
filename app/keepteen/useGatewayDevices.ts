import { useNetInfo } from '@react-native-community/netinfo';
import { useEffect, useRef, useState } from 'react';
import { currentWifiGateway, listGatewayClients, type GatewayClient } from '../gateway-lwm2m';
import { linkGatewayDevice } from '../gateway-local-devices';
import type { KeepteenRuntime } from './types';

// Gateway discovery changes the existing product data, without adding home UI.
export function useGatewayDevices(runtime: KeepteenRuntime, onDevicesChanged: () => Promise<void>) {
  const network = useNetInfo();
  const changed = useRef(onDevicesChanged);
  changed.current = onDevicesChanged;
  const [state, setState] = useState<{ profileId: string; clients: GatewayClient[]; connected: boolean }>({ profileId: '', clients: [], connected: false });
  useEffect(() => {
    if (runtime.onlineMode) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
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
      } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [runtime.profile.id, runtime.onlineMode, network.type, network.isConnected,
    network.details && 'ipAddress' in network.details ? network.details.ipAddress : null]);
  const active = !runtime.onlineMode && state.profileId === runtime.profile.id;
  return { clients: active ? state.clients : [], connected: active ? state.connected : undefined };
}
