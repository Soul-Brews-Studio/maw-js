import { Elysia, t} from "elysia";
import { getFederationStatus } from "../core/transport/peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../core/fleet/snapshot";
import { hostedAgents } from "../commands/shared/federation-sync";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FLEET_DIR } from "../core/paths";
import { getPeerKey } from "../lib/peer-key";

/**
 * Endpoints advertised by /api/identity (#804 Step 1).
 *
 * Lets peers discover supported API surfaces in one round-trip instead of
 * probing each path individually. Keep alphabetised + in sync with the actual
 * mounted routes — this is a contract, not documentation.
 */
const ADVERTISED_ENDPOINTS: string[] = [
  "/api/identity",
  "/api/pane-keys",
  "/api/probe",
  "/api/send",
  "/api/sleep",
  "/api/wake",
];

// Re-export so existing importers (and any future code) can still reach
// hostedAgents via the API module. The canonical home is federation-sync.ts.
export { hostedAgents };

export const federationApi = new Elysia();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
// See docs/federation.md before changing fields.
federationApi.get("/federation/status", async () => {
  const status = await getFederationStatus();
  return status;
});

/** Snapshots API — list and view fleet time machine snapshots */
federationApi.get("/snapshots", () => {
  return listSnapshots();
});

federationApi.get("/snapshots/:id", ({ params, set}) => {
  const snap = loadSnapshot(params.id);
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
  const config = loadConfig();
  const node = config.node ?? "local";
  const oracle = config.oracle ?? "mawjs";
  const agents = hostedAgents(config.agents || {}, node);
  const pkg = require("../../package.json");
  return {
    node,
    oracle,
    version: pkg.version,
    agents,
    uptime: Math.floor(process.uptime()),
    clockUtc: new Date().toISOString(),
    endpoints: ADVERTISED_ENDPOINTS,
    pubkey: getPeerKey(),
  };
});

/** Message log — query maw-log.jsonl for federation link data */
federationApi.get("/messages", ({ query }) => {
  const from = query.from;
  const to = query.to;
  const limit = Math.min(parseInt(query.limit || "100"), 1000);
  const logFile = join(homedir(), ".oracle", "maw-log.jsonl");
  try {
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    interface MawMessage { ts: string; from: string; to: string; msg: string; host?: string; route?: string }
    let messages: MawMessage[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (from) messages = messages.filter(m => m.from?.includes(from));
    if (to) messages = messages.filter(m => m.to?.includes(to));
    return { messages: messages.slice(-limit), total: messages.length };
  } catch {
    return { messages: [], total: 0 };
  }
}, {
  query: t.Object({
    from: t.Optional(t.String()),
    to: t.Optional(t.String()),
    limit: t.Optional(t.String()),
  }),
});

/** Fleet configs — serve fleet/*.json with lineage data */
federationApi.get("/fleet", () => {
  try {
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => {
      try { return { file: f, ...JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8")) }; } catch { return null; }
    }).filter(Boolean);
    return { fleet: configs };
  } catch {
    return { fleet: [] };
  }
});

/** Auth status — public diagnostic endpoint (never reveals the token) */
federationApi.get("/auth/status", () => {
  const config = loadConfig();
  const token = config.federationToken;
  return {
    enabled: !!token,
    tokenConfigured: !!token,
    tokenPreview: token ? token.slice(0, 4) + "****" : null,
    method: token ? "HMAC-SHA256" : "none",
    clockUtc: new Date().toISOString(),
    node: config.node ?? "local",
  };
});
