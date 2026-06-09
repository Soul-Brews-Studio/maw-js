/**
 * Transport registry — creates and wires all transports from config.
 */

import { loadConfig } from "../config";
import { TransportRouter } from "../core/transport/transport";
import { TmuxTransport } from "./tmux";
import { HttpTransport } from "./http";
import { NanoclawTransport } from "./nanoclaw";
import { ScoutTransport } from "./scout";
import type { Transport } from "../core/transport/transport";
import { importPluginSymbol } from "../plugin/registry";
import type { MawConfig } from "../config/types";
// ZenohTransport loaded dynamically — zenoh-ts bundles WASM that conflicts with single-file build

type DiscoveryTransport = "scout" | "zenoh" | "both" | "off";

type PluginTransportFactory = (config: MawConfig) => Transport | null | undefined | Promise<Transport | null | undefined>;

const ZENOH_SCOUT_PLUGIN = "zenoh-scout";
const ZENOH_SCOUT_TRANSPORT_FACTORY = "createZenohScoutTransport";

export function discoveryTransport(config: ReturnType<typeof loadConfig>): DiscoveryTransport {
  const scoutDisabled = process.env.MAW_NO_SCOUT === "1" || config.scout === false;
  const zenohPluginEnabled = !(config.disabledPlugins ?? []).includes(ZENOH_SCOUT_PLUGIN);
  const configured = config.discovery?.transport;
  if (configured === "scout" || configured === "zenoh" || configured === "both" || configured === "off") {
    if (scoutDisabled && configured === "scout") return "off";
    if (scoutDisabled && configured === "both") return zenohPluginEnabled ? "zenoh" : "off";
    if (zenohPluginEnabled) return configured;
    if (configured === "zenoh") return "off";
    if (configured === "both") return "scout";
    return configured;
  }
  if (!zenohPluginEnabled) return scoutDisabled ? "off" : "scout";
  if (config.zenoh?.scout?.enabled === true) return scoutDisabled ? "zenoh" : "both";
  return scoutDisabled ? "off" : "scout";
}

/** Singleton router instance */
let router: TransportRouter | null = null;
let routerProfileKey = "all";

function transportEnabled(profile: Set<string> | null, name: string): boolean {
  return !profile || profile.has(name);
}

function transportProfileKey(transports?: string[]): string {
  return transports === undefined ? "all" : [...new Set(transports)].sort().join(",");
}

/** Build transport router from maw.config.json */
export function createTransportRouter(transports?: string[]): TransportRouter {
  const profileKey = transportProfileKey(transports);
  if (router && routerProfileKey === profileKey) return router;
  if (router) router.disconnectAll().catch(() => {});

  const config = loadConfig();
  const enabledTransports = transports === undefined ? null : new Set(transports);
  router = new TransportRouter(config.broadcastTo ?? []);
  routerProfileKey = profileKey;

  // 1. Always register tmux (local fast path) by default — auto-connected
  if (transportEnabled(enabledTransports, "tmux")) {
    const tmux = new TmuxTransport();
    tmux.connect().catch(() => {}); // tmux is always available locally
    router.register(tmux);
  }

  const discovery = discoveryTransport(config);

  // 2.5. Scout P2P — zero-config LAN discovery + auto-pairing.
  if (transportEnabled(enabledTransports, "scout") && (discovery === "scout" || discovery === "both")) {
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
  // Pairing/trust remains in MAW's HTTP pair/peers flow. The transport is
  // provided by the plugin module surface so core does not import vendored code.
  if (transportEnabled(enabledTransports, "zenoh-scout") && (discovery === "zenoh" || discovery === "both")) {
    const zenohScout = new PluginTransportAdapter(ZENOH_SCOUT_PLUGIN, ZENOH_SCOUT_TRANSPORT_FACTORY, config);
    zenohScout.connect().catch(() => {});
    router.register(zenohScout);
  }

  // 2.6. Zenoh transport — pub/sub + auto-discovery (dynamic import — WASM)
  if (transportEnabled(enabledTransports, "zenoh") && config.zenoh?.locator) {
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
  if (transportEnabled(enabledTransports, "http") && config.peers && config.peers.length > 0) {
    router.register(
      new HttpTransport({
        peers: config.peers,
        selfHost: config.node ?? "local",
      }),
    );
  }

  // 4. NanoClaw (external chat channels — Telegram, Discord, etc.)
  if (transportEnabled(enabledTransports, "nanoclaw")) router.register(new NanoclawTransport());

  return router;
}


class PluginTransportAdapter implements Transport {
  readonly name: string;
  private inner: Transport | null = null;
  private loading: Promise<void> | null = null;
  private readonly messageHandlers = new Set<Parameters<Transport["onMessage"]>[0]>();
  private readonly presenceHandlers = new Set<Parameters<Transport["onPresence"]>[0]>();
  private readonly feedHandlers = new Set<Parameters<Transport["onFeed"]>[0]>();

  constructor(
    pluginName: string,
    private readonly symbolName: string,
    private readonly config: MawConfig,
  ) {
    this.name = pluginName;
  }

  get connected(): boolean {
    return this.inner?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (this.inner) return await this.inner.connect();
    if (this.loading) return this.loading;
    this.loading = this.loadAndConnect().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async disconnect(): Promise<void> {
    await this.inner?.disconnect();
    this.inner = null;
  }

  async send(target: Parameters<Transport["send"]>[0], message: string): Promise<boolean> {
    return await this.inner?.send(target, message) ?? false;
  }

  async publishPresence(presence: Parameters<Transport["publishPresence"]>[0]): Promise<void> {
    await this.inner?.publishPresence(presence);
  }

  async publishFeed(event: Parameters<Transport["publishFeed"]>[0]): Promise<void> {
    await this.inner?.publishFeed(event);
  }

  onMessage(handler: Parameters<Transport["onMessage"]>[0]): void {
    this.messageHandlers.add(handler);
    this.inner?.onMessage(handler);
  }

  onPresence(handler: Parameters<Transport["onPresence"]>[0]): void {
    this.presenceHandlers.add(handler);
    this.inner?.onPresence(handler);
  }

  onFeed(handler: Parameters<Transport["onFeed"]>[0]): void {
    this.feedHandlers.add(handler);
    this.inner?.onFeed(handler);
  }

  canReach(target: Parameters<Transport["canReach"]>[0]): boolean {
    return this.inner?.canReach(target) ?? false;
  }

  listPeers(): unknown[] {
    const listPeers = (this.inner as (Transport & { listPeers?: () => unknown[] }) | null)?.listPeers;
    return typeof listPeers === "function" ? listPeers.call(this.inner) : [];
  }

  private async loadAndConnect(): Promise<void> {
    try {
      const factory = await importPluginSymbol<PluginTransportFactory>(this.name, this.symbolName);
      const transport = await factory(this.config);
      if (!transport) return;
      for (const handler of this.messageHandlers) transport.onMessage(handler);
      for (const handler of this.presenceHandlers) transport.onPresence(handler);
      for (const handler of this.feedHandlers) transport.onFeed(handler);
      await transport.connect();
      this.inner = transport;
    } catch (e) {
      console.warn(`[${this.name}] transport load failed: ${e}`);
    }
  }
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
  routerProfileKey = "all";
}

export { TmuxTransport } from "./tmux";
export { HttpTransport } from "./http";
export { NanoclawTransport } from "./nanoclaw";
export { ScoutTransport } from "./scout";
// Zenoh scout transport is provided by the zenoh-scout plugin module surface.
// ZenohTransport exported via dynamic import only (WASM dependency)
