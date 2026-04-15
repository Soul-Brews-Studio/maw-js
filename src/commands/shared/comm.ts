import {
  listSessions, capture, sendKeys, getPaneCommand, getPaneCommands, getPaneInfos,
  findWindow, runHook, scanWorktrees, curlFetch, findPeerForTarget, resolveTarget,
  hostExec,
  type SshSession as Session,
} from "../../sdk";
import { loadConfig, cfgLimit } from "../../config";
import { resolveFleetSession } from "./wake";
import { appendFile, mkdir } from "fs/promises";
import { homedir, hostname } from "os";
import { join } from "path";

/** Log message to ~/.oracle/maw-log.jsonl with normalized from/to */
async function logMessage(from: string, to: string, msg: string, route: string) {
  const config = loadConfig();
  if (!config.node) throw new Error("config.node is required — set 'node' in maw.config.json");
  const normalizedFrom = from.includes(":") ? from : `${config.node}:${from}`;
  const logDir = join(homedir(), ".oracle");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    from: normalizedFrom,
    to,
    msg: msg.slice(0, 500),
    host: hostname(),
    route,
  }) + "\n";
  try { await mkdir(logDir, { recursive: true }); await appendFile(join(logDir, "maw-log.jsonl"), line); } catch {}
}

/** Emit feed event to server plugin pipeline (CLI → server bridge) */
function emitFeed(event: string, oracle: string, node: string, message: string, port: number) {
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, oracle, host: node, message, ts: Date.now() }),
  }).catch(() => {});
}

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

/**
 * Resolve a `session:window` target to a specific pane running an agent
 * (claude / codex / node). Fixes the multi-pane routing bug: when an oracle
 * window has multiple panes (e.g., team-agents split beside it), tmux's
 * `send-keys -t session:window` defaults to the LAST-ACTIVE pane — which
 * becomes whichever teammate just spawned, not the oracle itself.
 *
 * Strategy: list all panes in the window, pick the lowest-index pane
 * running a claude/codex/node process. Pane 0 is conventionally the
 * oracle's main pane (created by `tmux.newWindow` during `maw wake`);
 * team-agents spawn LATER as splits and take higher indexes.
 *
 * If the target already specifies a pane (`.N` suffix) the caller knows
 * what they want — pass through untouched. If no agent pane is found,
 * return the target unchanged so the existing "no active Claude session"
 * error path surfaces correctly.
 */
async function resolveOraclePane(target: string): Promise<string> {
  // Already pane-specific — honor caller's choice.
  if (/\.[0-9]+$/.test(target)) return target;

  try {
    const raw = await hostExec(
      `tmux list-panes -t '${target}' -F '#{pane_index} #{pane_current_command}'`,
    );
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return target; // single-pane window: active pane is the only pane

    const agentIndexes: number[] = [];
    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const idx = parseInt(line.slice(0, spaceIdx), 10);
      const cmd = line.slice(spaceIdx + 1);
      if (Number.isFinite(idx) && /claude|codex|node/i.test(cmd)) {
        agentIndexes.push(idx);
      }
    }
    if (agentIndexes.length === 0) return target;
    return `${target}.${Math.min(...agentIndexes)}`;
  } catch {
    return target;
  }
}

/** Resolve the current oracle name from CLAUDE_AGENT_NAME or tmux session */
function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  // Try tmux session name: "08-mawjs" → "mawjs"
  try {
    const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
    if (tmuxSession) return tmuxSession.replace(/^\d+-/, "");
  } catch {}
  return config.node || "cli";
}

export async function cmdSend(query: string, message: string, force = false) {
  const config = loadConfig();

  // --- Plugin routing: maw hey plugin:<name> <msg> ---
  if (query.startsWith("plugin:")) {
    const name = query.slice("plugin:".length);
    const { discoverPackages, invokePlugin } = await import("../../plugin/registry");
    const plugin = discoverPackages().find(p => p.manifest.name === name);
    if (!plugin) { console.error(`plugin not found: ${name}`); process.exit(1); }
    const result = await invokePlugin(plugin, { source: "peer", args: { message, from: config.node ?? "local" } });
    if (result.ok) { console.log(result.output ?? "(no output)"); return; }
    console.error(`plugin error: ${result.error}`);
    process.exit(1);
  }

  const sessions = await listSessions();

  // --- Unified resolution via resolveTarget (#201) ---
  const result = resolveTarget(query, config, sessions);

  // Local target (or self-node) → send via tmux.
  // Resolve to a specific pane first: when the oracle window has multiple
  // panes (team-agents spawned beside it), `send-keys -t session:window`
  // would otherwise land in whichever pane is currently active, not the
  // oracle's claude pane. See resolveOraclePane.
  if (result?.type === "local" || result?.type === "self-node") {
    const target = await resolveOraclePane(result.target);
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
    if (!config.node) throw new Error("config.node is required — set 'node' in maw.config.json");
    const senderName = resolveMyName(config);
    logMessage(senderName, query, message, "local");
    emitFeed("MessageSend", senderName, config.node, `${query}: ${message.slice(0, 200)}`, config.port || 3456);
    await Bun.sleep(150);
    let lastLine = "";
    try { const content = await capture(target, 3); lastLine = content.split("\n").filter(l => l.trim()).pop() || ""; } catch {}
    console.log(`\x1b[32mdelivered\x1b[0m → ${target}: ${message}`);
    if (lastLine) console.log(`\x1b[90m  ⤷ ${lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
    return;
  }

  // Remote peer → federation HTTP
  if (result?.type === "peer") {
    const res = await curlFetch(`${result.peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: result.target, text: message }),
    });
    if (res.ok && res.data?.ok) {
      const agentName = resolveMyName(config);
      logMessage(agentName, query, message, `peer:${result.node}`);
      emitFeed("MessageSend", agentName, config.node!, `${result.node}:${query}: ${message.slice(0, 200)}`, config.port || 3456);
      console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${result.node} → ${res.data.target || result.target}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
    console.error(`\x1b[31mfailed\x1b[0m ⚡ ${result.node} → ${result.target}: ${res.data?.error || "send failed"}`);
    process.exit(1);
  }

  // Fallback: async peer discovery (network scan — slow path)
  const peerUrl = await findPeerForTarget(query, sessions);
  if (peerUrl) {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: message }),
    });
    if (res.ok && res.data?.ok) {
      console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
  }

  // Not found — surface error details from resolveTarget (#216)
  if (result?.type === "error") {
    console.error(`\x1b[31merror\x1b[0m: ${result.detail}`);
    if (result.hint) console.error(`\x1b[33mhint\x1b[0m:  ${result.hint}`);
  } else {
    console.error(`\x1b[31merror\x1b[0m: window not found: ${query}`);
    if (config.agents && Object.keys(config.agents).length > 0) {
      console.error(`\x1b[33mhint\x1b[0m:  known agents: ${Object.keys(config.agents).join(", ")}`);
    }
  }
  process.exit(1);
}
