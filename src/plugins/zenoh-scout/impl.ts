import { createHash } from "crypto";

import type { MawConfig } from "maw-js/config/types";
import type {
  Transport,
  TransportTarget,
  TransportMessage,
  TransportPresence,
} from "maw-js/core/transport/transport";
import type { FeedEvent } from "maw-js/lib/feed";

export interface ZenohDiscoveredPeer {
  zid: string;
  node: string;
  host: string;
  oracle: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  lastSeen: number;
  paired: boolean;
}

export interface ZenohScoutConfig {
  enabled: boolean;
  locator: string;
  timeoutMs: number;
  keyPrefix: string;
  node: string;
  oracle: string;
  apiUrl: string;
  capabilities: string[];
  advertise?: boolean;
}

export interface ZenohScoutPeer {
  zid: string;
  node: string;
  oracle: string;
  host: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  firstSeen: string;
  lastSeen: string;
  seenRel: string;
  paired: boolean;
  transport: "zenoh";
}

export interface ZenohScoutResult {
  ok: boolean;
  enabled: boolean;
  locator: string;
  keyPrefix: string;
  total: number;
  peers: ZenohScoutPeer[];
  error?: string;
  hint?: string;
}

export interface ZenohApi {
  Config: new (locator: string, timeoutMs?: number) => unknown;
  KeyExpr: new (key: string) => unknown;
  Session?: { open(config: unknown): Promise<ZenohSession> };
  open?: (config: unknown) => Promise<ZenohSession>;
  Duration?: { milliseconds?: { of(ms: number): unknown } };
}

export interface ZenohSession {
  liveliness(): {
    declareToken(key: unknown): Promise<{ undeclare(): Promise<void> }>;
    get(key: unknown, opts?: Record<string, unknown>): Promise<AsyncIterable<unknown> | undefined>;
  };
  close(): Promise<void>;
}

export type ImportZenoh = () => Promise<ZenohApi>;

const DEFAULT_LOCATOR = "ws://127.0.0.1:10000";
const DEFAULT_TIMEOUT_MS = 750;
const DEFAULT_KEY_PREFIX = "maw/discovery/v1";
const DEFAULT_CAPABILITIES = ["pair", "feed", "send"];

export function readZenohScoutConfig(config: MawConfig): ZenohScoutConfig {
  const rawZenoh = config.zenoh ?? {};
  const rawScout = rawZenoh.scout ?? {};
  const node = config.node ?? "local";
  const oracle = config.oracle ?? "mawjs";
  const port = config.port ?? 3456;
  const locator = rawScout.locator ?? rawZenoh.locator ?? DEFAULT_LOCATOR;
  const timeoutMs = Number.isFinite(rawScout.timeoutMs)
    ? Math.max(1, Number(rawScout.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const keyPrefix = rawScout.keyPrefix?.replace(/\/+$/g, "") || DEFAULT_KEY_PREFIX;

  return {
    enabled: rawScout.enabled === true,
    locator,
    timeoutMs,
    keyPrefix,
    node,
    oracle,
    apiUrl: `http://${node}:${port}`,
    capabilities: DEFAULT_CAPABILITIES,
    advertise: true,
  };
}

export function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeSegment(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function discoveryKey(config: ZenohScoutConfig): string {
  return [
    config.keyPrefix,
    encodeSegment(config.node),
    encodeSegment(config.oracle),
    encodeSegment(config.apiUrl),
    encodeSegment(config.capabilities.join(",")),
    "alive",
  ].join("/");
}

export function parseDiscoveryKey(key: string, keyPrefix = DEFAULT_KEY_PREFIX, now = new Date()): ZenohScoutPeer | null {
  const prefix = keyPrefix.replace(/\/+$/g, "");
  if (!key.startsWith(prefix + "/")) return null;
  const rest = key.slice(prefix.length + 1).split("/");
  if (rest.length !== 5 || rest[4] !== "alive") return null;
  const [nodeRaw, oracleRaw, urlRaw, capsRaw] = rest;
  const node = decodeSegment(nodeRaw ?? "");
  const oracle = decodeSegment(oracleRaw ?? "");
  const url = decodeSegment(urlRaw ?? "");
  const caps = decodeSegment(capsRaw ?? "");
  if (!node || !oracle || !url) return null;
  const iso = now.toISOString();
  return {
    zid: `zenoh:${hashKey(key).slice(0, 16)}`,
    node,
    oracle,
    host: hostFromUrl(url),
    locators: [url],
    capabilities: caps ? caps.split(",").filter(Boolean) : [],
    oracles: [oracle],
    firstSeen: iso,
    lastSeen: iso,
    seenRel: "now",
    paired: false,
    transport: "zenoh",
  };
}

export async function runZenohScout(
  config: ZenohScoutConfig,
  deps: { importZenoh?: ImportZenoh; now?: () => Date } = {},
): Promise<ZenohScoutResult> {
  const importZenoh = deps.importZenoh ?? (() => import("@eclipse-zenoh/zenoh-ts") as Promise<ZenohApi>);
  const now = deps.now ?? (() => new Date());
  let session: ZenohSession | null = null;
  let token: { undeclare(): Promise<void> } | null = null;

  try {
    const zenoh = await importZenoh();
    const sessionConfig = new zenoh.Config(config.locator, config.timeoutMs);
    session = zenoh.Session?.open
      ? await zenoh.Session.open(sessionConfig)
      : await zenoh.open!(sessionConfig);

    const liveliness = session.liveliness();
    if (config.advertise !== false) {
      token = await liveliness.declareToken(new zenoh.KeyExpr(discoveryKey(config)));
    }

    const timeout = zenoh.Duration?.milliseconds?.of(config.timeoutMs) ?? config.timeoutMs;
    const receiver = await liveliness.get(new zenoh.KeyExpr(`${config.keyPrefix}/**`), { timeout });
    const peers = new Map<string, ZenohScoutPeer>();
    if (receiver) {
      for await (const reply of receiver) {
        const key = keyexprFromReply(reply);
        if (!key) continue;
        const peer = parseDiscoveryKey(key, config.keyPrefix, now());
        if (!peer) continue;
        if (peer.node === config.node && peer.oracle === config.oracle) continue;
        peers.set(peer.zid, peer);
      }
    }

    const rows = [...peers.values()].sort((a, b) => a.node.localeCompare(b.node) || a.oracle.localeCompare(b.oracle));
    return {
      ok: true,
      enabled: true,
      locator: config.locator,
      keyPrefix: config.keyPrefix,
      total: rows.length,
      peers: rows,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      enabled: true,
      locator: config.locator,
      keyPrefix: config.keyPrefix,
      total: 0,
      peers: [],
      error: classifyZenohFailure(message),
      hint: `${message} — ${zenohUnavailableHint(message)}`,
    };
  } finally {
    if (token) await token.undeclare().catch(() => {});
    if (session) await session.close().catch(() => {});
  }
}

export function formatZenohScoutResult(result: ZenohScoutResult): string {
  if (!result.enabled) {
    return `zenoh-scout disabled\n  locator: ${result.locator}\n  hint: ${result.hint ?? "set zenoh.scout.enabled=true"}`;
  }
  if (!result.ok) {
    return `zenoh-scout unavailable\n  locator: ${result.locator}\n  error: ${result.error ?? "unknown"}\n  hint: ${result.hint ?? "check zenohd remote-api"}`;
  }
  if (result.peers.length === 0) {
    return `no zenoh discoveries\n  locator: ${result.locator}\n  key: ${result.keyPrefix}/**`;
  }
  const header = ["zid", "node", "oracle", "host", "caps"];
  const rows = result.peers.map((p) => [
    p.zid.replace(/^zenoh:/, "").slice(0, 8) + "…",
    p.node,
    p.oracle,
    p.host,
    p.capabilities.join(",") || "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

export function keyexprFromReply(reply: unknown): string | null {
  const maybeResult = typeof (reply as any)?.result === "function" ? (reply as any).result() : reply;
  const maybeSample = maybeResult && typeof (maybeResult as any).keyexpr === "function" ? maybeResult : null;
  if (!maybeSample) return null;
  const keyexpr = (maybeSample as any).keyexpr();
  if (keyexpr && typeof keyexpr.toString === "function") return keyexpr.toString();
  return typeof keyexpr === "string" ? keyexpr : null;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

function zenohUnavailableHint(message: string): string {
  if (/wasm|__wbindgen|WebAssembly/i.test(message)) {
    return "zenoh-ts failed to initialize in this runtime; keep zenoh-scout opt-in and verify the zenoh-ts/remote-api runtime before enabling";
  }
  if (/Cannot find module|Module not found|not found/i.test(message)) {
    return "install @eclipse-zenoh/zenoh-ts or run a maw build that bundles/externalizes it correctly";
  }
  return "start zenohd with the remote-api bridge or pass --locator";
}

function classifyZenohFailure(message: string): string {
  if (/wasm|__wbindgen|WebAssembly/i.test(message)) return "zenoh_runtime_unsupported";
  return "zenoh_unavailable";
}


export interface ZenohScoutTransportConfig extends ZenohScoutConfig {
  pollMs?: number;
  importZenoh?: ImportZenoh;
  now?: () => Date;
}

const DEFAULT_POLL_MS = 5_000;

export class ZenohScoutTransport implements Transport {
  readonly name = "zenoh-scout";
  private _connected = false;
  private readonly config: ZenohScoutTransportConfig;
  private zenoh: ZenohApi | null = null;
  private session: ZenohSession | null = null;
  private token: { undeclare(): Promise<void> } | null = null;
  private readonly peers = new Map<string, ZenohDiscoveredPeer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private msgHandlers = new Set<(msg: TransportMessage) => void>();
  private presenceHandlers = new Set<(p: TransportPresence) => void>();
  private feedHandlers = new Set<(e: FeedEvent) => void>();

  constructor(config: ZenohScoutTransportConfig) {
    this.config = config;
  }

  get connected() {
    return this._connected;
  }

  async connect(): Promise<void> {
    await this.refresh();
    const pollMs = Math.max(250, this.config.pollMs ?? DEFAULT_POLL_MS);
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, pollMs);
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.closeSession();
    this.peers.clear();
    this._connected = false;
  }

  async send(_target: TransportTarget, _message: string): Promise<boolean> {
    return false;
  }

  async publishPresence(_presence: TransportPresence): Promise<void> {
    await this.refresh();
  }

  async publishFeed(_event: FeedEvent): Promise<void> {}

  onMessage(handler: (msg: TransportMessage) => void) {
    this.msgHandlers.add(handler);
  }

  onPresence(handler: (p: TransportPresence) => void) {
    this.presenceHandlers.add(handler);
  }

  onFeed(handler: (e: FeedEvent) => void) {
    this.feedHandlers.add(handler);
  }

  canReach(_target: TransportTarget): boolean {
    return false;
  }

  listPeers(): ZenohDiscoveredPeer[] {
    return [...this.peers.values()];
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshInner().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshInner(): Promise<void> {
    try {
      await this.ensureSession();
      const zenoh = this.zenoh!;
      const session = this.session!;
      const timeout = zenoh.Duration?.milliseconds?.of(this.config.timeoutMs) ?? this.config.timeoutMs;
      const receiver = await session.liveliness().get(new zenoh.KeyExpr(`${this.config.keyPrefix}/**`), { timeout });
      const next = new Map<string, ZenohDiscoveredPeer>();
      const now = this.config.now?.() ?? new Date();
      if (receiver) {
        for await (const reply of receiver) {
          const key = keyexprFromReply(reply);
          if (!key) continue;
          const peer = parseDiscoveryKey(key, this.config.keyPrefix, now);
          if (!peer) continue;
          if (peer.node === this.config.node && peer.oracle === this.config.oracle) continue;
          const previous = this.peers.get(peer.zid);
          const lastSeen = Date.parse(peer.lastSeen);
          next.set(peer.zid, {
            zid: peer.zid,
            node: peer.node,
            host: peer.host,
            oracle: peer.oracle,
            locators: peer.locators,
            capabilities: peer.capabilities,
            oracles: peer.oracles,
            lastSeen: Number.isFinite(lastSeen) ? lastSeen : now.getTime(),
            paired: previous?.paired ?? peer.paired,
          });
          this.emitPresence(peer.oracle, peer.host, "ready");
        }
      }
      this.peers.clear();
      for (const [zid, peer] of next) this.peers.set(zid, peer);
      this._connected = true;
    } catch {
      this._connected = false;
      await this.closeSession();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.session && this.zenoh && (this.config.advertise === false || this.token)) return;
    const importZenoh = this.config.importZenoh ?? (() => import("@eclipse-zenoh/zenoh-ts") as Promise<ZenohApi>);
    const zenoh = await importZenoh();
    const sessionConfig = new zenoh.Config(this.config.locator, this.config.timeoutMs);
    const session = zenoh.Session?.open
      ? await zenoh.Session.open(sessionConfig)
      : await zenoh.open!(sessionConfig);
    const token = this.config.advertise === false
      ? null
      : await session.liveliness().declareToken(new zenoh.KeyExpr(discoveryKey(this.config)));
    this.zenoh = zenoh;
    this.session = session;
    this.token = token;
  }

  private async closeSession(): Promise<void> {
    if (this.token) {
      await this.token.undeclare().catch(() => {});
      this.token = null;
    }
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    this.zenoh = null;
  }

  private emitPresence(oracle: string, host: string, status: TransportPresence["status"]): void {
    for (const h of this.presenceHandlers) {
      h({ oracle, host, status, timestamp: Date.now() });
    }
  }
}


export function createZenohScoutTransport(config: MawConfig): Transport {
  return new ZenohScoutTransport({
    ...readZenohScoutConfig(config),
    enabled: true,
  });
}
