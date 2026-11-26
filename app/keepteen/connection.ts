import type { MessageKey } from "./i18n";
import type { KeepteenRuntime } from "./types";
import type { StatusTone } from "./ui";

/**
 * One short primary status per product (handoff: "连接摘要只显示当前主要状态").
 * Offline profiles talk to the mesh through the profile's BLE companion;
 * cloud profiles read Appwrite. The BLE / HaLow / cloud details stay available
 * separately in the product's connection page.
 */
export function connectionSummary(runtime: KeepteenRuntime, useGateway = false): { tone: StatusTone; label: MessageKey } {
  if (runtime.onlineMode) {
    if (runtime.cloudStatus === "online") return { tone: "online", label: "statusCloudOnline" };
    if (runtime.cloudStatus === "login") return { tone: "warning", label: "statusSignInRequired" };
    return { tone: "warning", label: "statusCloudOffline" };
  }
  if (useGateway && runtime.gatewayConnected === true) return { tone: "online", label: "statusGatewayConnected" };
  if (useGateway && runtime.gatewayConnected === false && runtime.bleStatus.phase !== "ready") {
    return { tone: "warning", label: "statusGatewayUnavailable" };
  }
  switch (runtime.bleStatus.phase) {
    case "ready":
      return runtime.bleStatus.halowLinkUp === false
        ? { tone: "warning", label: "statusHalowDown" }
        : { tone: "online", label: "statusReady" };
    case "connected": return { tone: "warning", label: "statusConnected" };
    case "connecting":
    case "preparing": return { tone: "idle", label: "statusConnecting" };
    case "error": return { tone: "danger", label: "statusError" };
    case "not-selected": return { tone: "idle", label: "statusNoController" };
    default: return { tone: "idle", label: "statusNotConnected" };
  }
}
