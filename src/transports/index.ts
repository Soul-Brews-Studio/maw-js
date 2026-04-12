/**
 * Transport registry — creates and wires all transports from config.
 */

import { loadConfig } from "../config";
import { TransportRouter } from "../transport";
import { TmuxTransport } from "./tmux";
import { HttpTransport } from "./http";
import { HubTransport, loadWorkspaceConfigs } from "./hub";
import { LoRaTransport } from "./lora";

/** Singleton router instance */
let router: TransportRouter | null = null;

/** Build transport router from maw.config.json */
export function createTransportRouter(): TransportRouter {
  if (router) return router;

  const config = loadConfig();
  router = new TransportRouter();

  // 1. Always register tmux (local fast path) — auto-connected
  const tmux = new TmuxTransport();
  tmux.connect().catch(() => {}); // tmux is always available locally
  router.register(tmux);

  // 2. Hub transport — workspace WebSocket connections (priority 30)
  const workspaceConfigs = loadWorkspaceConfigs();
  if (workspaceConfigs.length > 0) {
    router.register(new HubTransport(config.node));
  }

  // 3. HTTP federation as fallback
  if (config.peers && config.peers.length > 0) {
    router.register(
      new HttpTransport({
        peers: config.peers,
        selfHost: config.node ?? "local",
      }),
    );
  }

  // 4. LoRa (future hardware — stub, canReach() always false)
  router.register(new LoRaTransport());

  return router;
}

/** Get existing router or create one */
export function getTransportRouter(): TransportRouter {
  return router || createTransportRouter();
}

/** Reset (for config reload) */
export function resetTransportRouter() {
  if (router) {
    router.disconnectAll().catch(() => {});
    router = null;
  }
}

export { TmuxTransport } from "./tmux";
export { HubTransport } from "./hub";
export { HttpTransport } from "./http";
export { LoRaTransport } from "./lora";
