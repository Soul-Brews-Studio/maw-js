import { getPeers, curlFetch } from "../../sdk";
import { tmux } from "../../sdk";
import { loadConfig } from "../../config";
import { buildAgentRows, type AgentRow } from "./agents";

export interface FederationAgent {
  node: string;
  oracle: string;
  session: string;
  window: string;
  state: string;
  pid?: number;
}

export interface SkippedNode {
  label: string;
  url: string;
  error: string;
}

type FetchFn = (url: string, opts?: { timeout?: number }) => Promise<{ ok: boolean; status: number; data: unknown }>;

export interface FederationAgentDeps {
  fetch: FetchFn;
  getLocalAgents: (nodeName: string) => Promise<FederationAgent[]>;
  peers: () => string[];
  namedPeers: () => { name: string; url: string }[];
  nodeName: () => string;
}

function labelForPeer(url: string, named: { name: string; url: string }[]): string {
  const match = named.find(p => p.url === url);
  if (match) return match.name;
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1"
      ? `localhost:${u.port}` : u.host;
  } catch { return url; }
}

async function defaultGetLocalAgents(nodeName: string): Promise<FederationAgent[]> {
  const [sessions, panes] = await Promise.all([tmux.listAll(), tmux.listPanes()]);
  const windowNames = new Map<string, string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      windowNames.set(`${s.name}:${w.index}`, w.name);
    }
  }
  const rows: AgentRow[] = buildAgentRows(panes, windowNames, nodeName);
  return rows.map(r => ({
    node: r.node,
    oracle: r.oracle,
    session: r.session,
    window: r.window,
    state: r.state,
    pid: r.pid ?? undefined,
  }));
}

function matchGlob(pattern: string, str: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(str);
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

export async function cmdFederationAgents(
  opts: { json?: boolean; node?: string; oracle?: string },
  _deps?: Partial<FederationAgentDeps>,
): Promise<void> {
  const config = loadConfig();
  const rawNodeName = config.node || "local";
  const named = config.namedPeers ?? [];

  const deps: FederationAgentDeps = {
    fetch: curlFetch as FetchFn,
    getLocalAgents: defaultGetLocalAgents,
    peers: getPeers,
    namedPeers: () => named,
    nodeName: () => rawNodeName,
    ..._deps,
  };

  const nodeName = deps.nodeName();
  const agents: FederationAgent[] = [];
  const skipped: SkippedNode[] = [];

  // Local agents
  try {
    const local = await deps.getLocalAgents(nodeName);
    agents.push(...local);
  } catch {
    // non-fatal
  }

  // Peer agents — parallel, isolated failures
  const peers = deps.peers();
  if (peers.length > 0) {
    const results = await Promise.allSettled(
      peers.map(url =>
        deps.fetch(`${url}/api/agents`, { timeout: 3000 }).then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status || "error"}`);
          return { url, data: res.data };
        })
      )
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const url = peers[i];
      if (r.status === "fulfilled") {
        const raw = r.value.data as { agents?: FederationAgent[] } | null;
        if (Array.isArray(raw?.agents)) {
          agents.push(...raw.agents);
        }
      } else {
        const label = labelForPeer(url, deps.namedPeers());
        const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
        skipped.push({ label, url, error });
      }
    }
  }

  // Apply filters
  let filtered = agents;
  if (opts.node) {
    filtered = filtered.filter(a => a.node === opts.node);
  }
  if (opts.oracle) {
    const pattern = opts.oracle;
    filtered = filtered.filter(a => matchGlob(pattern, a.oracle));
  }

  if (opts.json) {
    console.log(JSON.stringify({ agents: filtered, skipped }, null, 2));
    return;
  }

  // Render table
  const COL = { node: 16, oracle: 18, session: 24, state: 8 };
  const header =
    pad("node", COL.node) +
    pad("oracle", COL.oracle) +
    pad("session", COL.session) +
    "state";
  console.log(header);
  console.log("─".repeat(header.length));

  if (filtered.length === 0) {
    console.log("\x1b[90mno agents found\x1b[0m");
  } else {
    for (const a of filtered) {
      const nodeLabel = a.node === nodeName ? `${a.node} (local)` : a.node;
      const dot = a.state === "active" ? "\x1b[32m●\x1b[0m" : "\x1b[90m●\x1b[0m";
      const stateColor = a.state === "active" ? "\x1b[32m" : "\x1b[90m";
      console.log(
        pad(nodeLabel, COL.node) +
        pad(a.oracle, COL.oracle) +
        pad(a.session, COL.session) +
        `${dot} ${stateColor}${a.state}\x1b[0m`
      );
    }
  }

  if (skipped.length > 0) {
    console.log("");
    for (const s of skipped) {
      console.log(`\x1b[33m! ${s.label}\x1b[0m  unreachable (${s.error})`);
    }
  }
}
