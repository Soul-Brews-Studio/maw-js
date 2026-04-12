/**
 * maw transport status — show transport layer connectivity.
 */

import { getTransportRouter } from "../transports";
import { loadConfig } from "../config";

export async function cmdTransportStatus() {
  const config = loadConfig() as any;
  const router = getTransportRouter();

  const node = config.node ?? "local";
  console.log(`\n\x1b[36;1mTransport Status\x1b[0m  \x1b[90m(node: ${node})\x1b[0m\n`);

  const statuses = router.status();
  const notes: Record<string, string> = {
    "tmux": "local",
    "http-federation": config.peers?.length ? `${config.peers.length} peer(s)` : "no peers",
    "lora": "no hardware",
  };

  for (let i = 0; i < statuses.length; i++) {
    const t = statuses[i];
    const dot = t.connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const status = t.connected ? "\x1b[32mconnected\x1b[0m" : "\x1b[31mdisconnected\x1b[0m";
    const note = notes[t.name] ? `  \x1b[90m(${notes[t.name]})\x1b[0m` : "";
    console.log(`  ${i + 1}. ${dot}  ${t.name.padEnd(18)}  ${status}${note}`);
  }

  // Show agent registry if configured
  if (config.agents && Object.keys(config.agents).length > 0) {
    console.log(`\n  \x1b[36mAgent Registry:\x1b[0m`);
    for (const [agent, agentNode] of Object.entries(config.agents)) {
      const local = agentNode === node;
      const dot = local ? "\x1b[32m●\x1b[0m" : "\x1b[34m●\x1b[0m";
      console.log(`    ${dot} ${agent} → ${agentNode}${local ? " (local)" : ""}`);
    }
  }

  // Show hints for unconfigured
  const hints: string[] = [];
  if (!config.peers?.length) hints.push(`peers: "peers": ["http://host:3456"]`);
  if (!config.agents) hints.push(`agents: "agents": { "neo": "white" }`);
  if (hints.length > 0) {
    console.log(`\n  \x1b[90mConfigure in maw.config.json:\x1b[0m`);
    for (const h of hints) console.log(`    \x1b[90m${h}\x1b[0m`);
  }

  console.log();
}
