import { listSessions, findWindow, capture, sendKeys, getPaneCommand, getPaneCommands, getPaneInfos, Session } from "../ssh";
import { loadConfig } from "../config";
import { resolveFleetSession } from "./wake";
import { runHook } from "../hooks";
import { scanWorktrees } from "../worktrees";
import { curlFetch } from "../curl-fetch";

/** Resolve which sessions to search for an oracle query (#86). */
function resolveSearchSessions(query: string, sessions: Session[]): Session[] {
  const config = loadConfig();
  // 1. Check config.sessions mapping
  const mapped = (config.sessions as Record<string, string>)?.[query];
  if (mapped) {
    const filtered = sessions.filter(s => s.name === mapped);
    if (filtered.length > 0) return filtered;
  }
  // 2. Check fleet configs for oracle → session mapping
  const fleetSession = resolveFleetSession(query);
  if (fleetSession) {
    const filtered = sessions.filter(s => s.name === fleetSession);
    if (filtered.length > 0) return filtered;
  }
  // 3. Fallback: search all
  return sessions;
}

export async function cmdList() {
  const sessions = await listSessions();

  // Batch-check process + cwd for each pane
  const targets: string[] = [];
  for (const s of sessions) {
    for (const w of s.windows) targets.push(`${s.name}:${w.index}`);
  }
  const infos = await getPaneInfos(targets);

  for (const s of sessions) {
    console.log(`\x1b[36m${s.name}\x1b[0m`);
    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      const info = infos[target] || { command: "", cwd: "" };
      const isAgent = /claude|codex|node/i.test(info.command);
      const cwdBroken = info.cwd.includes("(deleted)") || info.cwd.includes("(dead)");

      let dot: string;
      let suffix = "";
      if (cwdBroken) {
        dot = "\x1b[31m●\x1b[0m"; // red — working dir deleted
        suffix = "  \x1b[31m(path deleted)\x1b[0m";
      } else if (w.active && isAgent) {
        dot = "\x1b[32m●\x1b[0m"; // green — active + agent running
      } else if (isAgent) {
        dot = "\x1b[34m●\x1b[0m"; // blue — agent running
      } else {
        dot = "\x1b[31m●\x1b[0m"; // red — dead (shell only)
        suffix = `  \x1b[90m(${info.command || "?"})\x1b[0m`;
      }
      console.log(`  ${dot} ${w.index}: ${w.name}${suffix}`);
    }
  }

  // Detect orphaned worktree directories (on disk but no tmux window)
  try {
    const worktrees = await scanWorktrees();
    const orphans = worktrees.filter(wt => wt.status === "stale" || wt.status === "orphan");
    if (orphans.length > 0) {
      console.log("");
      for (const wt of orphans) {
        const dirName = wt.path.split("/").pop() || wt.name;
        const label = wt.status === "orphan" ? "orphaned (prunable)" : "no tmux window";
        console.log(`  \x1b[33m⚠ orphaned:\x1b[0m ${dirName} \x1b[90m(${label})\x1b[0m`);
      }
    }
  } catch { /* worktree scan failed — non-critical */ }
}

export async function cmdPeek(query?: string) {
  const config = loadConfig();

  // Node prefix: "white:neo-maw-js" → peek remote agent via federation
  if (query && query.includes(":") && !query.includes("/")) {
    const [nodeName, agentName] = query.split(":", 2);
    const peer = config.namedPeers?.find(p => p.name === nodeName);
    const peerUrl = peer?.url || config.peers?.find(p => p.includes(nodeName));
    if (peerUrl) {
      const res = await curlFetch(`${peerUrl}/api/capture?target=${encodeURIComponent(agentName)}`);
      if (res.ok && res.data?.content) {
        console.log(`\x1b[36m--- ${query} (${nodeName}) ---\x1b[0m`);
        console.log(res.data.content);
        return;
      }
      console.error(`\x1b[31merror\x1b[0m: capture failed for ${agentName} on ${nodeName}${res.data?.error ? `: ${res.data.error}` : ""}`);
      process.exit(1);
    }
  }

  const sessions = await listSessions();
  if (!query) {
    // Peek all — one line per agent
    for (const s of sessions) {
      for (const w of s.windows) {
        const target = `${s.name}:${w.index}`;
        try {
          const content = await capture(target, 3);
          const lastLine = content.split("\n").filter(l => l.trim()).pop() || "(empty)";
          const dot = w.active ? "\x1b[32m*\x1b[0m" : " ";
          console.log(`${dot} \x1b[36m${w.name.padEnd(22)}\x1b[0m ${lastLine.slice(0, 80)}`);
        } catch {
          console.log(`  \x1b[36m${w.name.padEnd(22)}\x1b[0m (unreachable)`);
        }
      }
    }
    return;
  }
  const searchIn = resolveSearchSessions(query, sessions);
  const target = findWindow(searchIn, query);
  if (!target) { console.error(`window not found: ${query}`); process.exit(1); }
  const content = await capture(target);
  console.log(`\x1b[36m--- ${target} ---\x1b[0m`);
  console.log(content);
}

export async function cmdSend(query: string, message: string, force = false) {
  const config = loadConfig();

  // Node prefix syntax: "mba:homekeeper" → force route to mba node
  if (query.includes(":") && !query.includes("/")) {
    const [nodeName, agentName] = query.split(":", 2);
    const peer = config.namedPeers?.find(p => p.name === nodeName);
    const peerUrl = peer?.url || config.peers?.find(p => p.includes(nodeName));
    if (peerUrl) {
      const res = await curlFetch(`${peerUrl}/api/send`, {
        method: "POST",
        body: JSON.stringify({ target: agentName, text: message }),
      });
      if (res.ok && res.data?.ok) {
        console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${nodeName} → ${res.data.target || agentName}: ${message}`);
        if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, 100)}\x1b[0m`);
        await runHook("after_send", { to: query, message });
        return;
      }
      console.error(`\x1b[31mfailed\x1b[0m ⚡ ${nodeName} → ${agentName}: ${res.data?.error || "send failed"}`);
      process.exit(1);
    }
  }

  const sessions = await listSessions();
  const searchIn = resolveSearchSessions(query, sessions);
  const target = findWindow(searchIn, query);

  // Local target found → send via tmux
  if (target) {
    // Detect active Claude session (#17)
    if (!force) {
      const cmd = await getPaneCommand(target);
      const isAgent = /claude|codex|node/i.test(cmd);
      if (!isAgent) {
        console.error(`\x1b[31merror\x1b[0m: no active Claude session in ${target} (running: ${cmd})`);
        console.error(`\x1b[33mhint\x1b[0m:  run \x1b[36mmaw wake ${query}\x1b[0m first, or use \x1b[36m--force\x1b[0m to send anyway`);
        process.exit(1);
      }
    }

    await sendKeys(target, message);
    await runHook("after_send", { to: query, message });
    // Delivery confirmation: capture last line after brief delay
    await Bun.sleep(150);
    let lastLine = "";
    try {
      const content = await capture(target, 3);
      lastLine = content.split("\n").filter(l => l.trim()).pop() || "";
    } catch {}
    console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${message}`);
    if (lastLine) console.log(`\x1b[90m  ⤷ ${lastLine.slice(0, 100)}\x1b[0m`);
    return;
  }

  // Not found locally → check agent registry for remote routing
  const agentNode = config.agents?.[query] || config.agents?.[query.replace(/-oracle$/, "")];
  if (agentNode && agentNode !== (config.node || "local")) {
    // Route via federation (same as maw wire but auto-detected)
    const port = config.port || 3456;
    const res = await curlFetch(`http://localhost:${port}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: message }),
    });
    if (res.ok && res.data?.ok) {
      const source = res.data.source === "local" ? "local" : `⚡ ${res.data.source}`;
      console.log(`\x1b[32mdelivered\x1b[0m ${source} → ${res.data.target}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, 100)}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
    console.error(`\x1b[31mfailed\x1b[0m: agent ${query} → node "${agentNode}" — ${res.data?.error || "send failed"}`);
    process.exit(1);
  }

  console.error(`\x1b[31merror\x1b[0m: window not found: ${query}`);
  if (config.agents && Object.keys(config.agents).length > 0) {
    console.error(`\x1b[33mhint\x1b[0m:  known agents: ${Object.keys(config.agents).join(", ")}`);
  }
  process.exit(1);
}

/** maw wire — federation send via local maw server's /api/send (routes to peers) */
export async function cmdWire(query: string, message: string) {
  const config = loadConfig();
  const port = config.port || 3456;

  const res = await curlFetch(`http://localhost:${port}/api/send`, {
    method: "POST",
    body: JSON.stringify({ target: query, text: message }),
  });

  if (!res.ok || !res.data?.ok) {
    console.error(`\x1b[31merror\x1b[0m: ${res.data?.error || "wire send failed"}`);
    process.exit(1);
  }

  const source = res.data.source === "local" ? "local" : `⚡ ${res.data.source}`;
  console.log(`\x1b[36mwired\x1b[0m ${source} → ${res.data.target}: ${message}`);
}
