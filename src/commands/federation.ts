import { getFederationStatus, getPeers } from "../peers";
import { curlFetch } from "../curl-fetch";
import { listSessions } from "../ssh";
import { loadConfig } from "../config";

async function fetchPeerAgentCount(url: string): Promise<number> {
  try {
    const res = await curlFetch(`${url}/api/sessions`, { timeout: 3000 });
    if (!res.ok) return 0;
    const sessions: { windows: unknown[] }[] = res.data || [];
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Count local agents = sum of windows across local tmux sessions. */
async function countLocalAgents(): Promise<number> {
  try {
    const sessions = await listSessions();
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** Build a human-readable label for a peer URL, preferring namedPeers.name. */
function labelForPeer(url: string, named: { name: string; url: string }[]): string {
  const match = named.find(p => p.url === url);
  if (match) return match.name;
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1"
      ? `localhost:${u.port}` : u.host;
  } catch { return url; }
}

/** maw federation status — show all nodes (local + peers) with connectivity + agent counts */
export async function cmdFederationStatus() {
  const peers = getPeers();
  const config = loadConfig();
  const named = config.namedPeers ?? [];
  const totalNodes = peers.length + 1; // +1 for local
  const localLabel = config.node ? `${config.node} (local)` : "local";

  // Header always includes local, so "N nodes (1 local + M peers)"
  console.log(
    `\n\x1b[36;1mFederation Status\x1b[0m  ` +
    `\x1b[90m${totalNodes} node${totalNodes !== 1 ? "s" : ""} ` +
    `(1 local + ${peers.length} peer${peers.length !== 1 ? "s" : ""})\x1b[0m\n`
  );

  // Fetch local + peer state in parallel
  const [localCount, { peers: statuses, localUrl }] = await Promise.all([
    countLocalAgents(),
    getFederationStatus(),
  ]);

  // Render local row FIRST — the triangle is only visible if local is in the table
  console.log(
    `  \x1b[32m●\x1b[0m  \x1b[37m${localLabel}\x1b[0m  ` +
    `\x1b[32monline\x1b[0m  ` +
    `\x1b[90m${localCount} agent${localCount !== 1 ? "s" : ""}\x1b[0m`
  );
  console.log(`     \x1b[90m${localUrl}\x1b[0m`);

  // No peers? Still show helpful hint.
  if (peers.length === 0) {
    console.log("\n\x1b[90mNo peers configured. Add namedPeers[] to maw.config.json.\x1b[0m");
    console.log('\x1b[90mExample: { "namedPeers": [{ "name": "other", "url": "http://other-host:3456" }] }\x1b[0m\n');
    return;
  }

  // Fetch peer agent counts in parallel for online peers
  const counts = await Promise.all(
    statuses.map(p => p.reachable ? fetchPeerAgentCount(p.url) : Promise.resolve(0))
  );

  let online = 1; // local is always online (we're executing in it)
  for (let i = 0; i < statuses.length; i++) {
    const { url, reachable, latency } = statuses[i];
    const agentCount = counts[i];
    if (reachable) online++;

    const dot = reachable ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    const status = reachable
      ? `\x1b[32monline\x1b[0m  \x1b[90m${latency}ms · ${agentCount} agent${agentCount !== 1 ? "s" : ""}\x1b[0m`
      : "\x1b[31moffline\x1b[0m";

    const label = labelForPeer(url, named);
    console.log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${status}`);
    console.log(`     \x1b[90m${url}\x1b[0m`);
  }

  console.log(`\n\x1b[90m${online}/${totalNodes} online\x1b[0m\n`);
}
