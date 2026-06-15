import { Elysia, t } from "elysia";
import { getFederationStatus } from "../core/transport/peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot } from "../core/fleet/snapshot";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { mawMessageLogCandidatePaths } from "../core/xdg";
import { fleetDirsForRead, uniqueDirs } from "../core/fleet/paths";

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
  includeFederationStatus?: boolean;
  getFederationStatus?: typeof getFederationStatus;
  listSnapshots?: typeof listSnapshots;
  loadSnapshot?: typeof loadSnapshot;
  loadConfig?: typeof loadConfig;
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
  const includeFederationStatus = deps.includeFederationStatus ?? true;

  const federationApi = new Elysia();

  // PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
  // clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
  // See docs/federation.md before changing fields.
  if (includeFederationStatus) {
    federationApi.get("/federation/status", async () => {
      const status = await federationStatus();
      return status;
    });
  }

  /** Snapshots API — list and view fleet time machine snapshots */
  federationApi.get("/snapshots", () => {
    return snapshots();
  });

  federationApi.get("/snapshots/:id", ({ params, set }) => {
    const snap = snapshot(params.id);
    if (!snap) { set.status = 404; return { error: "snapshot not found" }; }
    return snap;
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

export const federationApi = createFederationApi({ includeFederationStatus: false });
