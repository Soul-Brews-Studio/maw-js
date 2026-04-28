/**
 * maw SDK — typed, safe API for command plugins.
 *
 * Instead of execSync("curl ...") + JSON.parse, plugins use:
 *   import { maw } from "@maw-js/sdk";
 *   const id = await maw.identity();  // typed!
 *
 * Three layers:
 *   maw.*        — API calls to maw serve (typed responses)
 *   maw.tmux.*   — tmux operations (list, send, capture)
 *   maw.print.*  — colored terminal output helpers
 */

import { loadConfig } from "../../config";
import type { Static } from "@sinclair/typebox";
import {
  Identity as IdentitySchema,
  Peer as PeerSchema,
  FederationStatus as FederationStatusSchema,
  Session as SessionSchema,
  FeedEvent as FeedEventSchema,
  PluginInfo as PluginInfoSchema,
} from "../../lib/schemas";
import { print } from "./sdk-print";

// --- Types (derived from TypeBox schemas — single source of truth) ---

export type Identity = Static<typeof IdentitySchema>;
export type Peer = Static<typeof PeerSchema>;
export type FederationStatus = Static<typeof FederationStatusSchema>;
export type Session = Static<typeof SessionSchema>;
export type FeedEvent = Static<typeof FeedEventSchema>;
export type PluginInfo = Static<typeof PluginInfoSchema>;

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

/** Node identity: name, version, agents, clock, endpoints, pubkey (#804 Step 1) */
async function identity(): Promise<Identity> {
  return api<Identity>("/api/identity", {
    node: "unknown",
    version: "?",
    agents: [],
    clockUtc: "",
    uptime: 0,
    endpoints: [],
    pubkey: "",
  });
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

// --- Export ---

export { print };

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
