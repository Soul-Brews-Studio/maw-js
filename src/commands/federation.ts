import { getFederationStatus, getPeers } from "../peers";

async function fetchPeerAgentCount(url: string): Promise<number> {
  try {
    const res = await fetch(`${url}/api/sessions`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 0;
    const sessions: { windows: unknown[] }[] = await res.json();
    return sessions.reduce((n, s) => n + (s.windows?.length || 0), 0);
  } catch {
    return 0;
  }
}

/** maw federation status — show peer connectivity + agent counts */
export async function cmdFederationStatus() {
  const peers = getPeers();

  if (peers.length === 0) {
    console.log("\x1b[90mNo peers configured. Add peers[] to maw.config.json.\x1b[0m");
    console.log('\x1b[90mExample: { "peers": ["http://other-host:3456"] }\x1b[0m');
    return;
  }

  console.log(`\n\x1b[36;1mFederation Status\x1b[0m  \x1b[90m${peers.length} peer${peers.length !== 1 ? "s" : ""} configured\x1b[0m\n`);

  const { peers: statuses, localUrl } = await getFederationStatus();

  // Fetch agent counts in parallel for online peers
  const counts = await Promise.all(
    statuses.map(p => p.reachable ? fetchPeerAgentCount(p.url) : Promise.resolve(0))
  );

  let online = 0;
  for (let i = 0; i < statuses.length; i++) {
    const { url, reachable, latency } = statuses[i];
    const agentCount = counts[i];
    if (reachable) online++;

    const dot = reachable ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    const status = reachable
      ? `\x1b[32monline\x1b[0m  \x1b[90m${latency}ms · ${agentCount} agent${agentCount !== 1 ? "s" : ""}\x1b[0m`
      : "\x1b[31moffline\x1b[0m";

    let label: string;
    try {
      const u = new URL(url);
      label = u.hostname === "localhost" || u.hostname === "127.0.0.1"
        ? `localhost:${u.port}` : u.host;
    } catch { label = url; }

    console.log(`  ${dot}  \x1b[37m${label}\x1b[0m  ${status}`);
    console.log(`     \x1b[90m${url}\x1b[0m`);
  }

  console.log(`\n\x1b[90m${online}/${peers.length} online · local: ${localUrl}\x1b[0m\n`);
}
