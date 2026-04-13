/**
 * maw SDK — typed, safe API for command plugins.
 *
 * Instead of execSync("curl ...") + JSON.parse, plugins use:
 *   import { maw } from "maw/sdk";
 *   const id = await maw.identity();  // typed!
 *
 * Three layers:
 *   maw.*        — API calls to maw serve (typed responses)
 *   maw.tmux.*   — tmux operations (list, send, capture)
 *   maw.print.*  — colored terminal output helpers
 */

import { loadConfig } from "./config";

// --- Types ---

export interface Identity {
  node: string;
  version: string;
  agents: string[];
  clockUtc: string;
  uptime: number;
}

export interface Peer {
  url: string;
  reachable: boolean;
  latency?: number;
  node?: string;
  agents?: string[];
  clockDeltaMs?: number;
  clockWarning?: boolean;
}

export interface FederationStatus {
  localUrl: string;
  peers: Peer[];
  totalPeers: number;
  reachablePeers: number;
  clockHealth?: { clockUtc: string; timezone: string; uptimeSeconds: number };
}

export interface Session {
  name: string;
  source?: string;
  windows: { index: number; name: string; active: boolean }[];
}

export interface FeedEvent {
  timestamp: string;
  oracle: string;
  host: string;
  event: string;
  project: string;
  sessionId: string;
  message: string;
}

export interface PluginInfo {
  name: string;
  type: string;
  source: string;
  loadedAt: string;
  events: number;
  errors: number;
}

// --- Internal helpers ---

function baseUrl(): string {
  const config = loadConfig();
  const port = config.port || 3456;
  return `http://localhost:${port}`;
}

async function api<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return fallback;
    return await res.json() as T;
  } catch {
    return fallback;
  }
}

/** Typed fetch against maw serve. Throws on failure (unlike api() which swallows). */
async function typedFetch<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const { timeout = 5000, ...rest } = init || {};
  const res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(timeout), ...rest });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return await res.json() as T;
}

// --- API layer ---

/** Node identity: name, version, agents, clock */
async function identity(): Promise<Identity> {
  return api<Identity>("/api/identity", { node: "unknown", version: "?", agents: [], clockUtc: "", uptime: 0 });
}

/** Federation status: peers, latency, clock drift */
async function federation(): Promise<FederationStatus> {
  return api<FederationStatus>("/api/federation/status", { localUrl: "", peers: [], totalPeers: 0, reachablePeers: 0 });
}

/** Local + federated sessions */
async function sessions(local = false): Promise<Session[]> {
  return api<Session[]>(`/api/sessions${local ? "?local=true" : ""}`, []);
}

/** Feed events */
async function feed(limit = 50): Promise<FeedEvent[]> {
  return api<FeedEvent[]>(`/api/feed?limit=${limit}`, []);
}

/** Plugin stats */
async function plugins(): Promise<{ plugins: PluginInfo[]; totalEvents: number; totalErrors: number }> {
  return api("/api/plugins", { plugins: [], totalEvents: 0, totalErrors: 0 });
}

/** Node config (masked) */
async function config(): Promise<Record<string, unknown>> {
  return api("/api/config", {});
}

/** Wake an oracle */
async function wake(target: string, task?: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${baseUrl()}/api/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, task }),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

/** Sleep an oracle */
async function sleep(target: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${baseUrl()}/api/sleep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(5000),
    });
    return await res.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

/** Send message to agent */
async function send(target: string, text: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${baseUrl()}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, text }),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

// --- Print helpers ---

const c = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
};

const print = {
  /** Section header */
  header: (text: string) => console.log(`\n  ${c.cyan}${text}${c.reset}\n`),

  /** Success line */
  ok: (text: string) => console.log(`  ${c.green}✓${c.reset} ${text}`),

  /** Warning line */
  warn: (text: string) => console.log(`  ${c.yellow}⚠${c.reset} ${text}`),

  /** Error line */
  err: (text: string) => console.log(`  ${c.red}✗${c.reset} ${text}`),

  /** Dim/muted text */
  dim: (text: string) => console.log(`  ${c.dim}${text}${c.reset}`),

  /** Bullet list with colored dots */
  list: (items: string[], dot = "●", color = c.green) => {
    for (const item of items) console.log(`    ${color}${dot}${c.reset} ${item}`);
  },

  /** Key-value pair */
  kv: (key: string, value: string) => console.log(`  ${c.dim}${key}:${c.reset} ${value}`),

  /** Table (simple aligned columns) */
  table: (rows: string[][], header?: string[]) => {
    const allRows = header ? [header, ...rows] : rows;
    const widths = allRows[0].map((_, i) => Math.max(...allRows.map(r => (r[i] || "").length)));
    if (header) {
      console.log("  " + header.map((h, i) => h.padEnd(widths[i])).join("  "));
      console.log("  " + widths.map(w => "─".repeat(w)).join("  "));
    }
    for (const row of rows) {
      console.log("  " + row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
    }
  },

  /** Newline */
  nl: () => console.log(),
};

// --- Export ---

export const maw = {
  identity,
  federation,
  sessions,
  feed,
  plugins,
  config,
  wake,
  sleep,
  send,
  print,
  baseUrl,
  /** Typed fetch — throws on failure. Use for endpoints not wrapped by SDK methods. */
  fetch: typedFetch,
};

export default maw;
