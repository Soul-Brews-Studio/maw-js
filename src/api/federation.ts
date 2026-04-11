import { Hono } from "hono";
import { getFederationStatus } from "../peers";
import { loadConfig } from "../config";
import { listSnapshots, loadSnapshot, latestSnapshot } from "../snapshot";
import { hostedAgents } from "../commands/federation-sync";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { FLEET_DIR } from "../paths";

// Re-export so existing importers (and any future code) can still reach
// hostedAgents via the API module. The canonical home is federation-sync.ts.
export { hostedAgents };

export const federationApi = new Hono();

// PUBLIC FEDERATION API (v1) — no auth. Shape is load-bearing for lens
// clients; `peers[].node` and `peers[].agents` are optional (commit 9a0546d+).
// See docs/federation.md before changing fields.
federationApi.get("/federation/status", async (c) => {
  const status = await getFederationStatus();
  return c.json(status);
});

/** Snapshots API — list and view fleet time machine snapshots */
federationApi.get("/snapshots", (c) => {
  return c.json(listSnapshots());
});

federationApi.get("/snapshots/:id", (c) => {
  const snap = loadSnapshot(c.req.param("id"));
  if (!snap) return c.json({ error: "snapshot not found" }, 404);
  return c.json(snap);
});

/** Node identity — public endpoint for federation dedup (#192). */
federationApi.get("/identity", async (c) => {
  const config = loadConfig();
  const node = config.node ?? "local";
  const agents = hostedAgents(config.agents || {}, node);
  const pkg = require("../../package.json");
  return c.json({
    node,
    version: pkg.version,
    agents,
    uptime: Math.floor(process.uptime()),
  });
});

/** Message log — query maw-log.jsonl for federation link data */
federationApi.get("/messages", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 1000);
  const logFile = join(homedir(), ".oracle", "maw-log.jsonl");
  try {
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    interface MawMessage { ts: string; from: string; to: string; msg: string; host?: string; route?: string }
    let messages: MawMessage[] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (from) messages = messages.filter(m => m.from?.includes(from));
    if (to) messages = messages.filter(m => m.to?.includes(to));
    return c.json({ messages: messages.slice(-limit), total: messages.length });
  } catch {
    return c.json({ messages: [], total: 0 });
  }
});

/** Fleet configs — serve fleet/*.json with lineage data */
federationApi.get("/fleet", (c) => {
  try {
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
    const configs = files.map(f => {
      try { return { file: f, ...JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8")) }; } catch { return null; }
    }).filter(Boolean);
    return c.json({ fleet: configs });
  } catch {
    return c.json({ fleet: [] });
  }
});

/** Auth status — public diagnostic endpoint (never reveals the token) */
federationApi.get("/auth/status", (c) => {
  const config = loadConfig();
  const token = config.federationToken;
  return c.json({
    enabled: !!token,
    tokenConfigured: !!token,
    tokenPreview: token ? token.slice(0, 4) + "****" : null,
    method: token ? "HMAC-SHA256" : "none",
    clockUtc: new Date().toISOString(),
    node: config.node ?? "local",
  });
});
