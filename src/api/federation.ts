import { Elysia, t } from "elysia";
import { getFederationStatus } from "../core/transport/peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot } from "../core/fleet/snapshot";
import { hostedAgents as defaultHostedAgents } from "../commands/shared/federation-sync";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getPeerKey } from "../lib/peer-key";
import { resolveNodeIdentity } from "../core/fleet/node-identity";
import { mawMessageLogCandidatePaths } from "../core/xdg";
import { fleetDirsForRead, uniqueDirs } from "../core/fleet/paths";

/**
 * Endpoints advertised by /api/identity (#804 Step 1).
 *
 * Lets peers discover supported API surfaces in one round-trip instead of
 * probing each path individually. Keep alphabetised + in sync with the actual
 * mounted routes — this is a contract, not documentation.
 */
const ADVERTISED_ENDPOINTS: string[] = [
  "/api/identity",
  "/api/messages",
  "/api/pane-keys",
  "/api/probe",
  "/api/send",
  "/api/sleep",
  "/api/wake",
];

// Re-export so existing importers (and any future code) can still reach
// hostedAgents via the API module. The canonical home is federation-sync.ts.
export { defaultHostedAgents as hostedAgents };

type LedgerModule = {
  listMessageLedgerEvents: (query: {
    from?: string;
    to?: string;
    limit: number;
    direction?: any;
    state?: any;
    q?: string;
  }) => any[];
  messageLedgerDbPath: () => string;
};

export interface FederationApiDeps {
  getFederationStatus?: typeof getFederationStatus;
  listSnapshots?: typeof listSnapshots;
  loadSnapshot?: typeof loadSnapshot;
  loadConfig?: typeof loadConfig;
  hostedAgents?: typeof defaultHostedAgents;
  getPeerKey?: typeof getPeerKey;
  packageVersion?: string;
  uptime?: () => number;
  nowIso?: () => string;
  loadLedger?: () => Promise<LedgerModule>;
  readFileSync?: typeof readFileSync;
  readdirSync?: typeof readdirSync;
  join?: typeof join;
  homedir?: typeof homedir;
  messageLogPaths?: () => string[];
  fleetDir?: string;
  fleetDirs?: string[];
}

export function createFederationApi(deps: FederationApiDeps = {}) {
  const federationStatus = deps.getFederationStatus ?? getFederationStatus;
  const snapshots = deps.listSnapshots ?? listSnapshots;
  const snapshot = deps.loadSnapshot ?? loadSnapshot;
  const load = deps.loadConfig ?? loadConfig;
  const agentsForHost = deps.hostedAgents ?? defaultHostedAgents;
  const peerKey = deps.getPeerKey ?? getPeerKey;
  const version = deps.packageVersion ?? require("../../package.json").version;
  const uptime = deps.uptime ?? (() => process.uptime());
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const readFile = deps.readFileSync ?? readFileSync;
  const readDir = deps.readdirSync ?? readdirSync;
  const pathJoin = deps.join ?? join;
  const messageLogPaths = deps.messageLogPaths ?? mawMessageLogCandidatePaths;
  const fleetDirs = deps.fleetDirs?.length
    ? uniqueDirs(deps.fleetDirs)
    : deps.fleetDir
      ? [deps.fleetDir]
      : fleetDirsForRead();
  const loadLedger = deps.loadLedger ?? (async () => await import("../vendor/mpr-plugins/messages/ledger"));

  const federationApi = new Elysia();

  // PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
  // clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
  // See docs/federation.md before changing fields.
  federationApi.get("/federation/status", async () => {
    const status = await federationStatus();
    return status;
  });

  /** Snapshots API — list and view fleet time machine snapshots */
  federationApi.get("/snapshots", () => {
    return snapshots();
  });

  federationApi.get("/snapshots/:id", ({ params, set }) => {
    const snap = snapshot(params.id);
    if (!snap) { set.status = 404; return { error: "snapshot not found" }; }
    return snap;
  });

  /**
   * Node identity — public endpoint for federation dedup (#192) + clock health (#268).
   *
   * #804 Step 1 (ADR docs/federation/0001-peer-identity.md): also advertises
   *   - `endpoints`: supported API paths so peers can discover capabilities
   *     in one round-trip (closes the version-skew pressure).
   *   - `pubkey`: per-peer identity for TOFU pinning + Step 4 signing. Persisted
   *     at <CONFIG_DIR>/peer-key (SSH host-key model).
   */
  federationApi.get("/identity", async () => {
    const config = load();
    const identity = resolveNodeIdentity(config, {
      fallbackHost: "local",
      user: process.env.USER || process.env.LOGNAME,
    });
    const node = identity.node;
    const host = identity.host;
    const oracle = config.oracle ?? "mawjs";
    const agents = [...new Set([
      ...agentsForHost(config.agents || {}, node),
      ...(host !== node ? agentsForHost(config.agents || {}, host) : []),
    ])];
    return {
      node,
      host,
      ...(identity.user ? { user: identity.user } : {}),
      ...(identity.port !== undefined ? { port: identity.port } : {}),
      oracle,
      version,
      agents,
      uptime: Math.floor(uptime()),
      clockUtc: nowIso(),
      endpoints: ADVERTISED_ENDPOINTS,
      pubkey: peerKey(),
    };
  });

  /** Message log — query SQLite message ledger, falling back to legacy maw-log.jsonl. */
  federationApi.get("/messages", async ({ query }) => {
    const from = query.from;
    const to = query.to;
    const limit = Math.min(parseInt(query.limit || "100"), 1000);
    try {
      const { listMessageLedgerEvents, messageLedgerDbPath } = await loadLedger();
      const messages = listMessageLedgerEvents({
        from,
        to,
        limit,
        direction: query.direction as any,
        state: query.state as any,
        q: query.q,
      });
      if (messages.length > 0) {
        return { messages, total: messages.length, source: "sqlite", dbPath: messageLedgerDbPath() };
      }
    } catch {
      // Keep legacy endpoint non-fatal; fall through to JSONL.
    }

    for (const logFile of messageLogPaths()) {
      try {
        const lines = readFile(logFile, "utf-8").trim().split("\n").filter(Boolean);
        interface MawMessage { ts: string; from: string; to: string; msg: string; host?: string; route?: string }
        let messages: MawMessage[] = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (from) messages = messages.filter((m) => m.from?.includes(from));
        if (to) messages = messages.filter((m) => m.to?.includes(to));
        return { messages: messages.slice(-limit), total: messages.length };
      } catch {
        // Try the next migration candidate (XDG primary, then legacy ~/.oracle).
      }
    }
    return { messages: [], total: 0 };
  }, {
    query: t.Object({
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      direction: t.Optional(t.String()),
      state: t.Optional(t.String()),
      q: t.Optional(t.String()),
    }),
  });

  /** Fleet configs — serve fleet/*.json with lineage data */
  federationApi.get("/fleet", () => {
    const seenFiles = new Set<string>();
    const configs: unknown[] = [];
    try {
      for (const fleetDir of fleetDirs) {
        let files: string[];
        try {
          files = readDir(fleetDir).filter((f) => f.endsWith(".json") && !f.endsWith(".disabled")).sort();
        } catch {
          continue;
        }

        for (const file of files) {
          if (seenFiles.has(file)) continue;
          seenFiles.add(file);
          try {
            configs.push({ file, ...JSON.parse(readFile(pathJoin(fleetDir, file), "utf-8")) });
          } catch { /* skip invalid config */ }
        }
      }
      return { fleet: configs };
    } catch {
      return { fleet: [] };
    }
  });

  /** Auth status — public diagnostic endpoint (never reveals the token) */
  federationApi.get("/auth/status", () => {
    const config = load();
    const token = config.federationToken;
    return {
      enabled: !!token,
      tokenConfigured: !!token,
      tokenPreview: token ? token.slice(0, 4) + "****" : null,
      method: token ? "HMAC-SHA256" : "none",
      clockUtc: nowIso(),
      node: config.node ?? "local",
    };
  });

  return federationApi;
}

export const federationApi = createFederationApi();
