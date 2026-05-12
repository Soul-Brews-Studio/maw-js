import { loadConfig } from "../../config";
import { getPeers, curlFetch } from "../../sdk";
import {
  type FederationAgent,
  type FederationAgentDeps,
  type SkippedNode,
  defaultGetLocalAgents,
  describeFetchError,
  labelForPeer,
} from "./federation-agents";

export interface LocateDeps extends FederationAgentDeps {
  configAgentsMap: () => Record<string, string> | undefined;
}

export async function cmdLocate(
  query: string,
  opts: { json?: boolean },
  _deps?: Partial<LocateDeps>,
): Promise<void> {
  const config = loadConfig();
  const rawNodeName = config.node || "local";
  const named = config.namedPeers ?? [];

  const deps: LocateDeps = {
    fetch: curlFetch as FederationAgentDeps["fetch"],
    getLocalAgents: defaultGetLocalAgents,
    peers: getPeers,
    namedPeers: () => named,
    nodeName: () => rawNodeName,
    configAgentsMap: () => config.agents,
    ..._deps,
  };

  const nodeName = deps.nodeName();
  const agents: FederationAgent[] = [];
  const skipped: SkippedNode[] = [];

  try {
    const local = await deps.getLocalAgents(nodeName);
    agents.push(...local);
  } catch {
    // non-fatal
  }

  const peers = deps.peers();
  if (peers.length > 0) {
    const results = await Promise.allSettled(
      peers.map(url =>
        deps.fetch(`${url}/api/agents`, { timeout: 3000 }).then(res => {
          if (!res.ok) throw new Error(describeFetchError(res));
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

  const q = query.toLowerCase();
  const matching = agents.filter(a => a.oracle.toLowerCase() === q);
  const configNode = deps.configAgentsMap()?.[query];

  if (opts.json) {
    console.log(JSON.stringify({
      query,
      config: configNode ? { node: configNode } : null,
      federation: matching,
      skipped,
    }, null, 2));
    return;
  }

  console.log(`\n📍 ${query}`);

  if (configNode) {
    console.log(`   node:     ${configNode} (from config.agents)`);
  } else {
    console.log(`   node:     (not in config.agents)`);
  }

  if (matching.length > 0) {
    console.log(`\n   Running on federation:`);
    const byNode = new Map<string, FederationAgent[]>();
    for (const a of matching) {
      const list = byNode.get(a.node) ?? [];
      list.push(a);
      byNode.set(a.node, list);
    }
    const nodeWidth = Math.max(...[...byNode.keys()].map(n => n.length), 4) + 2;
    for (const [node, nodeAgents] of byNode) {
      for (const a of nodeAgents) {
        const dot = a.state === "active" ? "\x1b[32m●\x1b[0m" : "\x1b[90m●\x1b[0m";
        const stateColor = a.state === "active" ? "\x1b[32m" : "\x1b[90m";
        console.log(`     ${node.padEnd(nodeWidth)}${a.session} ${dot} ${stateColor}${a.state}\x1b[0m`);
      }
    }
  } else {
    console.log(`\n   \x1b[90mnot running anywhere in federation\x1b[0m`);
  }

  if (skipped.length > 0) {
    console.log("");
    for (const s of skipped) {
      console.log(`   \x1b[33m! ${s.label}\x1b[0m  ${s.error}`);
    }
  }

  console.log();
}
