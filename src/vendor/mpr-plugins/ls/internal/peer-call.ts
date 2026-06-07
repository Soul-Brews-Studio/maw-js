/**
 * Cross-node session listing for `maw ls`.
 *
 * `maw ls --federation` is the explicit cross-node path (#1870): local sessions
 * are listed first, peers are fetched in parallel via the ls plugin API (`GET /api/ls`), and
 * unreachable peers become warning rows instead of aborting the whole view.
 *
 * Existing drill-down entry points stay available:
 *   - `lsPeer(alias, {json})` — fetch one peer's sessions
 *   - `lsAllPeers({json})`   — fan out to every alias in ~/.maw/peers.json
 */

import type { InvokeResult } from "maw-js/plugin/types";

export interface PeerSession {
  name: string;
  windows: { name: string; index?: number; active?: boolean }[];
  source?: string;
}

export interface FetchResult {
  ok: boolean;
  status?: number;
  data?: any;
}

export interface LsNodePayload {
  alias?: string;
  node?: string;
  oracle?: string;
  url?: string;
  local?: boolean;
  sessions: PeerSession[];
  error?: string;
}

export interface LsFederatedOpts {
  json?: boolean;
  node?: string;
  active?: boolean;
  activeThresholdSec?: number;
  timeoutMs?: number;
  includeLocal?: boolean;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_ACTIVE_THRESHOLD_SEC = 30 * 60;

export async function fetchPeerSessions(peerUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult> {
  const { curlFetch } = await import("maw-js/sdk");
  return await curlFetch(`${peerUrl.replace(/\/+$/, "")}/api/ls`, {
    method: "GET",
    from: "auto",
    timeout: timeoutMs,
  });
}

function renderPeerHeader(alias: string, url: string, count: number): string {
  return `\x1b[36m📡 ${alias}\x1b[0m \x1b[90m@ ${url}\x1b[0m · ${count} session${count === 1 ? "" : "s"}`;
}

function renderPeerSessions(sessions: PeerSession[]): string[] {
  const lines: string[] = [];
  for (const s of sessions) {
    const tag = s.source && s.source !== "local" ? ` \x1b[90mvia ${s.source}\x1b[0m` : "";
    lines.push(`  \x1b[34m●\x1b[0m \x1b[36m${s.name}\x1b[0m${tag}`);
    for (const w of s.windows || []) {
      const dot = w.active ? "\x1b[32m●\x1b[0m" : "\x1b[90m●\x1b[0m";
      const idx = typeof w.index === "number" ? `${w.index}: ` : "";
      lines.push(`     ${dot} ${idx}${w.name}`);
    }
  }
  return lines;
}

function sessionsFromPayload(data: any): PeerSession[] {
  return payloadFromData(data).sessions;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function sessionsFromFormattedOutput(output: string): PeerSession[] {
  const sessions: PeerSession[] = [];
  let current: PeerSession | null = null;
  for (const originalLine of output.split("\n")) {
    const rawLine = stripAnsi(originalLine);
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const pane = line.match(/^\s*[●•]\s+(\d+):\s+(.+)$/);
    if (pane && current) {
      current.windows.push({ index: Number(pane[1]), name: pane[2].trim(), active: originalLine.includes("\x1b[32m") });
      continue;
    }
    if (!/^\s/.test(rawLine)) {
      current = { name: line.trim(), windows: [] };
      sessions.push(current);
    }
  }
  return sessions;
}

function payloadFromData(data: any): LsNodePayload {
  // Compatibility: older/plugin-wrapped peers may still return InvokeResult JSON.
  // Prefer structured payloads, but salvage JSON output and legacy ANSI output.
  if (data && typeof data === "object" && typeof data.output === "string") {
    try {
      return payloadFromData(JSON.parse(data.output));
    } catch {
      return { sessions: sessionsFromFormattedOutput(data.output) };
    }
  }

  if (Array.isArray(data)) return { sessions: data as PeerSession[] };
  if (data && typeof data === "object" && Array.isArray(data.sessions)) {
    return {
      alias: typeof data.alias === "string" ? data.alias : undefined,
      node: typeof data.node === "string" ? data.node : undefined,
      oracle: typeof data.oracle === "string" ? data.oracle : undefined,
      url: typeof data.url === "string" ? data.url : undefined,
      local: typeof data.local === "boolean" ? data.local : undefined,
      sessions: data.sessions as PeerSession[],
      error: typeof data.error === "string" ? data.error : undefined,
    };
  }
  return { sessions: [] };
}

function responseError(res: FetchResult, alias: string, url: string): string | null {
  if (res?.ok && res?.data && typeof res.data === "object" && res.data.ok === false) {
    return String(res.data.error || `peer ${alias} returned an error`);
  }
  if (res?.ok) return null;
  if (res?.status === 404) return `peer ${alias} does not support /api/ls (HTTP 404 at ${url})`;
  // curlSpawn uses curl -f, so HTTP 4xx/5xx can surface as curl exit 22
  // instead of the underlying HTTP status. Keep the row actionable.
  if (res?.status === 22) return `peer ${alias} returned an HTTP error for /api/ls at ${url} — upgrade peer or check maw serve`;
  if (res?.status === 28) return `peer ${alias} timed out after 2s at ${url}`;
  if (res?.status === 401 || res?.status === 403) {
    return `peer ${alias} rejected (HTTP ${res.status} at ${url}) — check federationToken / peer-identity keys`;
  }
  const detail = res?.data?.error || (res?.status ? `HTTP ${res.status}` : "no response");
  return `peer ls failed (${alias} ${url}): ${detail}`;
}

function parseEpochMap(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const [name, value] = line.split("\t");
    const epoch = Number(value);
    if (name && Number.isFinite(epoch)) out.set(name, epoch);
  }
  return out;
}

async function activeSessionNames(thresholdSec = DEFAULT_ACTIVE_THRESHOLD_SEC): Promise<Set<string> | null> {
  try {
    const { hostExec, tmuxCmd } = await import("maw-js/sdk");
    const raw = await hostExec(`${tmuxCmd()} list-sessions -F '#{session_name}\t#{session_activity}'`).catch(() => "");
    if (!raw) return null;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const active = new Set<string>();
    for (const [name, epoch] of parseEpochMap(raw)) {
      if (nowEpoch - epoch <= thresholdSec) active.add(name);
    }
    return active;
  } catch {
    return null;
  }
}

function filterSessions(sessions: PeerSession[], opts: { active?: boolean; activeNames?: Set<string> | null; filter?: string }): PeerSession[] {
  let out = sessions;
  if (opts.active && opts.activeNames) out = out.filter((session) => opts.activeNames!.has(session.name));
  const filter = opts.filter?.trim().toLowerCase();
  if (filter) {
    out = out.filter((session) =>
      session.name.toLowerCase().includes(filter) ||
      String(session.source ?? "").toLowerCase().includes(filter) ||
      (session.windows ?? []).some((w) => w.name.toLowerCase().includes(filter)),
    );
  }
  return out;
}

export async function localLsPayload(opts: { active?: boolean; activeThresholdSec?: number; filter?: string } = {}): Promise<LsNodePayload> {
  const { listSessions, loadConfig } = await import("maw-js/sdk");
  const config = loadConfig();
  const sessions = await listSessions();
  const activeNames = opts.active ? await activeSessionNames(opts.activeThresholdSec) : null;
  return {
    alias: config.node ?? "local",
    node: config.node ?? "local",
    oracle: config.oracle ?? "mawjs",
    local: true,
    sessions: filterSessions(sessions as PeerSession[], { active: opts.active, activeNames, filter: opts.filter }),
  };
}

function nodeMatches(payload: Pick<LsNodePayload, "alias" | "node" | "url">, filter: string): boolean {
  const q = filter.toLowerCase();
  return [payload.alias, payload.node, payload.url]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(q));
}

async function fetchPeerPayload(peer: { alias: string; url: string; node: string | null }, timeoutMs: number): Promise<LsNodePayload> {
  try {
    const res = await fetchPeerSessions(peer.url, timeoutMs);
    const error = responseError(res, peer.alias, peer.url);
    if (error) return { alias: peer.alias, node: peer.node ?? undefined, url: peer.url, sessions: [], error };
    const payload = payloadFromData(res.data);
    return {
      ...payload,
      alias: payload.alias ?? peer.alias,
      node: payload.node ?? peer.node ?? peer.alias,
      url: payload.url ?? peer.url,
      local: false,
      sessions: payload.sessions ?? [],
    };
  } catch (e: any) {
    const detail = e?.message || String(e);
    return { alias: peer.alias, node: peer.node ?? undefined, url: peer.url, sessions: [], error: `peer ls failed (${peer.alias} ${peer.url}): ${detail}` };
  }
}

export async function lsPeer(alias: string, opts: { json?: boolean }): Promise<InvokeResult> {
  const { resolvePeer } = await import("./peer-resolve");
  const peer = resolvePeer(alias);
  if (!peer) {
    return { ok: false, error: `unknown peer alias: ${alias} (see: maw peers list)` };
  }

  const payload = await fetchPeerPayload(peer, DEFAULT_TIMEOUT_MS);
  if (payload.error) return { ok: false, error: payload.error };
  const sessions = payload.sessions;

  if (opts.json) {
    return { ok: true, output: JSON.stringify({ peer: alias, url: peer.url, sessions }, null, 2) };
  }

  const lines: string[] = [renderPeerHeader(alias, peer.url, sessions.length), ""];
  if (sessions.length === 0) {
    lines.push("\x1b[90m  (no sessions)\x1b[0m");
  } else {
    lines.push(...renderPeerSessions(sessions));
  }
  lines.push("", `\x1b[90m  → maw hey ${alias}:<session>:<window>   send a message\x1b[0m`);
  return { ok: true, output: lines.join("\n") };
}

export async function lsAllPeers(opts: { json?: boolean }): Promise<InvokeResult> {
  const { resolveAllPeers } = await import("./peer-resolve");
  const peers = resolveAllPeers();
  if (peers.length === 0) {
    return { ok: false, error: "no peers configured (see: maw peers add)" };
  }

  const results = await Promise.all(peers.map((p) => fetchPeerPayload(p, DEFAULT_TIMEOUT_MS)));

  if (opts.json) {
    return {
      ok: true,
      output: JSON.stringify({
        peers: results.map((r) => r.error
          ? { alias: r.alias, url: r.url, error: r.error }
          : { alias: r.alias, url: r.url, sessions: r.sessions }),
      }, null, 2),
    };
  }

  const total = results.reduce((n, r) => n + (r.error ? 0 : r.sessions.length), 0);
  const lines: string[] = [
    `\x1b[36m📡 fleet view · ${peers.length} peer${peers.length === 1 ? "" : "s"} · ${total} session${total === 1 ? "" : "s"} total\x1b[0m`,
    "",
  ];
  for (const r of results) {
    if (r.error) {
      lines.push(`  \x1b[31m✗\x1b[0m ${r.alias} \x1b[90m(${r.url}) — ${r.error}\x1b[0m`);
      continue;
    }
    lines.push(
      `  \x1b[34m●\x1b[0m \x1b[36m${r.alias}\x1b[0m \x1b[90m(${r.url}) · ${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"}\x1b[0m`,
    );
    for (const s of r.sessions) {
      const tag = s.source && s.source !== "local" ? ` \x1b[90mvia ${s.source}\x1b[0m` : "";
      lines.push(`     \x1b[90m●\x1b[0m ${s.name}${tag}`);
    }
  }
  lines.push("", "\x1b[90m  → maw ls <peer>   drill into one\x1b[0m");
  return { ok: true, output: lines.join("\n") };
}

export async function lsFederated(opts: LsFederatedOpts = {}): Promise<InvokeResult> {
  const { resolveAllPeers } = await import("./peer-resolve");
  const includeLocal = opts.includeLocal !== false;
  const nodeFilter = opts.node?.trim();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const peers = resolveAllPeers().filter((peer) => !nodeFilter || nodeMatches(peer, nodeFilter));
  const local = includeLocal ? await localLsPayload({
    active: opts.active,
    activeThresholdSec: opts.activeThresholdSec,
    filter: nodeFilter,
  }).catch((e: any) => ({ alias: "local", node: "local", local: true, sessions: [], error: e?.message || String(e) } as LsNodePayload)) : null;

  const localMatches = local && (!nodeFilter || nodeMatches(local, nodeFilter) || local.sessions.length > 0);
  const remoteResults = await Promise.all(peers.map((peer) => fetchPeerPayload(peer, timeoutMs)));
  const nodes = [
    ...(local && localMatches ? [local] : []),
    ...remoteResults,
  ];

  if (nodeFilter && nodes.length === 0) {
    return { ok: false, error: `no local or peer node matches '${nodeFilter}'` };
  }

  const totalSessions = nodes.reduce((n, node) => n + (node.error ? 0 : node.sessions.length), 0);
  const reachableNodes = nodes.filter((node) => !node.error).length;

  if (opts.json) {
    return {
      ok: true,
      output: JSON.stringify({
        nodes,
        totalSessions,
        reachableNodes,
        totalNodes: nodes.length,
        timeoutMs,
      }, null, 2),
    };
  }

  const lines: string[] = [
    `\x1b[36m📡 fleet view · ${reachableNodes}/${nodes.length} node${nodes.length === 1 ? "" : "s"} reachable · ${totalSessions} session${totalSessions === 1 ? "" : "s"} total\x1b[0m`,
    "",
  ];
  for (const node of nodes) {
    const label = node.alias ?? node.node ?? node.url ?? "unknown";
    const location = node.local ? "local" : node.url ?? "peer";
    if (node.error) {
      lines.push(`  \x1b[31m✗\x1b[0m ${label} \x1b[90m(${location}) — ${node.error}\x1b[0m`);
      continue;
    }
    lines.push(`  \x1b[34m●\x1b[0m \x1b[36m${label}\x1b[0m \x1b[90m(${location}) · ${node.sessions.length} session${node.sessions.length === 1 ? "" : "s"}\x1b[0m`);
    for (const session of node.sessions) {
      const source = session.source && session.source !== "local" ? ` \x1b[90mvia ${session.source}\x1b[0m` : "";
      lines.push(`     \x1b[90m●\x1b[0m ${session.name}${source}`);
    }
  }
  lines.push("", "\x1b[90m  → maw ls   list only local sessions (fast default)\x1b[0m");
  return { ok: true, output: lines.join("\n") };
}

export const __private = { payloadFromData, sessionsFromPayload, responseError, sessionsFromFormattedOutput };
