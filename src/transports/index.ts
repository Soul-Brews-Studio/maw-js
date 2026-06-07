/**
 * Transport registry — creates and wires all transports from config.
 */

import { loadConfig } from "../config";
import { TransportRouter } from "../core/transport/transport";
import { TmuxTransport } from "./tmux";
import { HttpTransport } from "./http";
import { HubTransport, loadWorkspaceConfigs } from "./hub";
import { LoRaTransport } from "./lora";
import { NanoclawTransport } from "./nanoclaw";
import { MdnsTransport } from "./mdns";
import { ScoutTransport } from "./scout";
import { ZenohScoutTransport } from "./zenoh-scout";
import { readZenohScoutConfig } from "../vendor/mpr-plugins/zenoh-scout/impl";
// ZenohTransport loaded dynamically — zenoh-ts bundles WASM that conflicts with single-file build

type DiscoveryTransport = "scout" | "zenoh" | "both" | "off";

const ZENOH_SCOUT_PLUGIN = "zenoh-scout";

export function discoveryTransport(config: ReturnType<typeof loadConfig>): DiscoveryTransport {
  const zenohPluginEnabled = !(config.disabledPlugins ?? []).includes(ZENOH_SCOUT_PLUGIN);
  const configured = config.discovery?.transport;
  if (configured === "scout" || configured === "zenoh" || configured === "both" || configured === "off") {
    if (zenohPluginEnabled) return configured;
    if (configured === "zenoh") return "off";
    if (configured === "both") return "scout";
    return configured;
  }
  if (!zenohPluginEnabled) return "scout";
  return config.zenoh?.scout?.enabled === true ? "both" : "scout";
}

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

  const discovery = discoveryTransport(config);

  // 2.5. Scout P2P — zero-config LAN discovery + auto-pairing.
  if (discovery === "scout" || discovery === "both") {
    const oracles = Object.keys(config.agents || {}).filter(k => k.endsWith("-oracle"));
    const scout = new ScoutTransport({
      node: config.node ?? "local",
      oracle: config.oracle ?? "mawjs",
      port: config.port ?? 3456,
      oracles,
      autoPair: true,
    });
    scout.connect().catch(() => {});
    router.register(scout);
  }

  // 2.5b. Zenoh Scout — opt-in discovery/presence provider only.
  // Pairing/trust remains in MAW's HTTP pair/peers flow.
  if (discovery === "zenoh" || discovery === "both") {
    const zenohScout = new ZenohScoutTransport({
      ...readZenohScoutConfig(config),
      enabled: true,
    });
    zenohScout.connect().catch(() => {});
    router.register(zenohScout);
  }

  // 2.6. Zenoh transport — pub/sub + auto-discovery (dynamic import — WASM)
  if (config.zenoh?.locator) {
    import("./zenoh").then(({ ZenohTransport }) => {
      const zt = new ZenohTransport({
        locator: config.zenoh!.locator,
        node: config.node ?? "local",
      });
      zt.connect().catch((e) => console.warn(`[zenoh] connect failed: ${e}`));
      router!.register(zt);
    }).catch((e) => console.warn(`[zenoh] load failed: ${e}`));
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

  // 4. NanoClaw (external chat channels — Telegram, Discord, etc.)
  router.register(new NanoclawTransport());

  // 5. LoRa (future hardware — stub, canReach() always false)
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
export { NanoclawTransport } from "./nanoclaw";
export { LoRaTransport } from "./lora";
export { MdnsTransport } from "./mdns";
export { ScoutTransport } from "./scout";
export { ZenohScoutTransport } from "./zenoh-scout";
// ZenohTransport exported via dynamic import only (WASM dependency)
