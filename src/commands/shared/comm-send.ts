/**
 * comm-send.ts — cmdSend + resolveOraclePane + resolveMyName + writeInboxMessage.
 */

import {
  listSessions, capture, sendKeys, getPaneCommand, findPeerForTarget, resolveTarget,
  curlFetch, runHook,
} from "../../sdk";
import { Tmux } from "../../core/transport/tmux";
import { loadConfig, cfgLimit } from "../../config";
import { logMessage, emitFeed } from "./comm-log-feed";
import { writeInboxFile } from "../plugins/inbox/impl";

/**
 * Write a message to an oracle's ψ/inbox/ directory.
 * peerRoot is the oracle's repo root (contains ψ/ dir).
 * Called from route-comm.ts when --inbox is passed to `maw hey`.
 */
export function writeInboxMessage(peerRoot: string, from: string, to: string, body: string): string {
  const { join } = require("path");
  const inboxDir = join(peerRoot, "ψ", "inbox");
  return writeInboxFile(inboxDir, from, to, body);
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
/** @internal */
export async function resolveOraclePane(target: string): Promise<string> {
  // Already pane-specific — honor caller's choice.
  if (/\.[0-9]+$/.test(target)) return target;

  try {
    const t = new Tmux();
    const raw = await t.run("list-panes", "-t", target, "-F", "#{pane_index} #{pane_current_command}");
    const lines = raw.split("\n").map((l: string) => l.trim()).filter(Boolean);
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
/** @internal */
export function resolveMyName(config: ReturnType<typeof loadConfig>): string {
  if (process.env.CLAUDE_AGENT_NAME) return process.env.CLAUDE_AGENT_NAME;
  // Try tmux session name: "08-mawjs" → "mawjs"
  try {
    const tmuxSession = require("child_process").execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
    if (tmuxSession) return tmuxSession.replace(/^\d+-/, "");
  } catch {}
  return config.node || "cli";
}

/**
 * Check if a pane is idle — i.e., no user input is in progress on the prompt line.
 * Uses capture-pane to inspect the last visible line. If a shell prompt marker
 * ($, %, >, ❯, #) is followed by non-whitespace text, the user is mid-input.
 * Errors and non-shell panes (running agent) conservatively return idle=true.
 * (#405 — idle guard before send-keys)
 */
export async function checkPaneIdle(target: string, host?: string): Promise<{ idle: boolean; lastInput: string }> {
  try {
    const content = await capture(target, 5, host);
    const lines = content.split("\n").filter(l => l.trim());
    const lastLine = lines.at(-1) ?? "";
    // Strip ANSI escape codes
    const clean = lastLine.replace(/\x1b\[[0-9;]*[mGKHFJA-Z]/g, "").replace(/\r/g, "");
    // Idle: last line ends with prompt marker + optional whitespace (nothing typed)
    if (/[#$%>❯»]\s*$/.test(clean)) return { idle: true, lastInput: "" };
    // Not idle: prompt marker followed by non-whitespace user content
    const notIdleMatch = clean.match(/[#$%>❯»]\s+(\S.*)$/);
    if (notIdleMatch) return { idle: false, lastInput: notIdleMatch[1] };
    // No prompt visible (command running or agent output) → treat as idle
    return { idle: true, lastInput: "" };
  } catch {
    return { idle: true, lastInput: "" };
  }
}

/**
 * Phase 2 of #759 — bare-name hard rejection. The bare-name path is removed
 * outright: cmdSend prints this error to stderr and exits non-zero before
 * any resolution attempt. Replaces the Phase 1 `formatBareNameDeprecation`
 * warning. Shape is fixed per the issue and exercised by
 * test/isolated/hey-bare-name-rejection.test.ts.
 *
 * The triple `<node>:<session>:<agent>` form keeps `<node>` and `<session>`
 * as literal placeholders — the user is meant to run `maw locate <agent>`
 * to enumerate concrete candidates across the federation. Only `<agent>`
 * is substituted with the bare query the user actually typed.
 */
export function formatBareNameError(query: string): string {
  const RED = "\x1b[31m"; // error marker
  const C = "\x1b[36m";   // cyan — for canonical suggestion lines
  const D = "\x1b[90m";   // dim — for explanatory tail
  const R = "\x1b[0m";
  return [
    `${RED}error${R}: bare-name target removed — node prefix required`,
    ``,
    `  this node:`,
    `    ${C}maw hey local:${query} "..."${R}`,
    ``,
    `  cross-node candidates:`,
    `    ${C}maw hey <node>:<session>:${query} "..."${R}`,
    ``,
    `  ${D}run \`maw locate ${query}\` to enumerate across federation${R}`,
  ].join("\n");
}

export async function cmdSend(query: string, message: string, force = false) {
  const config = loadConfig();

  // #759 Phase 2 — bare-name targets are now a hard error. Reject before any
  // resolution work so users get a fast, deterministic failure pushing them
  // onto the canonical `<node>:<agent>` form. `team:` and `plugin:` prefixes
  // are special-cased downstream and have their own colon, so they pass.
  // `/` is reserved for path-style targets. MAW_QUIET no longer suppresses —
  // Phase 1's quiet-opt-out was a deprecation-window concession only.
  if (!query.includes(":") && !query.includes("/")) {
    console.error(formatBareNameError(query));
    process.exit(1);
  }

  // --- Team fan-out routing: maw hey team:<team-name> <msg> (#627) ---
  if (query.startsWith("team:")) {
    const teamName = query.slice("team:".length);
    if (!teamName) {
      console.error("usage: maw hey team:<team-name> <message>");
      process.exit(1);
    }
    const { getOracleMembers, loadOracleRegistry } = await import("../plugins/team/oracle-members");
    const senderOracle = resolveMyName(config);
    const members = getOracleMembers(teamName, senderOracle);
    if (members.length === 0) {
      const registry = loadOracleRegistry(teamName);
      if (registry && registry.members.length > 0) {
        console.error(`\x1b[31m✗\x1b[0m team '${teamName}' has only the sender ('${senderOracle}') as a member`);
        console.error(`\x1b[33mhint\x1b[0m: invite more members or set excludeSelf:false in the registry`);
      } else {
        console.error(`\x1b[31m✗\x1b[0m no oracle members in team '${teamName}'`);
        console.error(`\x1b[33mhint\x1b[0m: add members with: maw team oracle-invite <oracle-name> --team ${teamName}`);
      }
      process.exit(1);
    }
    const totalMembers = (loadOracleRegistry(teamName)?.members.length ?? members.length);
    if (totalMembers > members.length) {
      console.log(`\x1b[36m⚡\x1b[0m fan-out to ${members.length} oracle(s) in team '${teamName}' \x1b[90m(self '${senderOracle}' excluded)\x1b[0m:`);
    } else {
      console.log(`\x1b[36m⚡\x1b[0m fan-out to ${members.length} oracle(s) in team '${teamName}':`);
    }
    let delivered = 0;
    let failed = 0;

    // Fan-out sends individually. cmdSend calls process.exit on failure,
    // so we override it temporarily to keep iterating (#627 resilient fan-out).
    const origExit = process.exit;
    for (const member of members) {
      let memberFailed = false;
      process.exit = ((code?: number) => {
        memberFailed = true;
      }) as never;
      try {
        await cmdSend(member, message, force);
        if (!memberFailed) delivered++;
        else failed++;
      } catch (e: any) {
        failed++;
        console.error(`  \x1b[31m✗\x1b[0m ${member}: ${e?.message || "failed"}`);
      }
    }
    process.exit = origExit;

    console.log(`\x1b[36m⚡\x1b[0m fan-out complete: ${delivered} delivered, ${failed} failed`);
    return;
  }

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

  let sessions = await listSessions();

  // --- #736 Phase 1.2 + #791: auto-wake fleet-known targets (parity with maw view) ---
  // Mirrors view/impl.ts:107 — if the user's hey target is fleet-known but
  // no live session exists, silently wake it before sending. No y/N prompt:
  // fleet membership is sufficient signal that this isn't a typo.
  //
  // Local scope (no node prefix or matches config.node): wake locally via cmdWake.
  // Cross-node short form (<peer>:<agent>, no third colon): wake remotely via
  // peer's /api/wake (#791 — Option B from the design RFC). Canonical form
  // (<peer>:<session>:<window>) skips wake because the session is explicitly
  // named — wake on a session id would no-op or misroute.
  {
    const parts = query.split(":");
    const targetNode = parts.length >= 2 ? parts[0] : null;
    const bareAgent = parts.length >= 2 ? parts[1] : query;
    const isCanonical = parts.length >= 3;
    const isLocalScope = !targetNode || targetNode === config.node;
    if (isLocalScope && bareAgent && !isCanonical) {
      const hasLocalSession = sessions.some(s =>
        s.name === bareAgent ||
        s.windows.some(w => w.name === `${bareAgent}-oracle` || w.name === bareAgent)
      );
      if (!hasLocalSession) {
        try {
          const { resolveFleetSession } = await import("./wake-resolve");
          if (resolveFleetSession(bareAgent)) {
            console.log(`\x1b[36m⚡\x1b[0m '${bareAgent}' is fleet-known — auto-wake`);
            const { cmdWake } = await import("./wake-cmd");
            await cmdWake(bareAgent, {});
            // Refresh after wake — resolver needs the new tmux session visible.
            sessions = await listSessions();
          }
        } catch { /* fleet/wake best-effort — fall through to existing error path */ }
      }
    } else if (targetNode && bareAgent && !isCanonical) {
      // #791: cross-node auto-wake. Sender does explicit /api/wake before
      // /api/send (Option B). Wake is idempotent on the receiver — if the
      // session already exists, cmdWake returns quickly. If wake errors,
      // surface and exit (do NOT silently fall through to send — design
      // call requires wake errors to be visible).
      const peer = (config.namedPeers || []).find(p => p.name === targetNode);
      if (peer) {
        const wakeRes = await curlFetch(`${peer.url}/api/wake`, {
          method: "POST",
          body: JSON.stringify({ target: bareAgent }),
          from: "auto", // #804 Step 4 SIGN — sign cross-node /api/wake
        });
        if (!wakeRes.ok || !wakeRes.data?.ok) {
          const underlying = wakeRes.data?.error || (wakeRes.status ? `HTTP ${wakeRes.status}` : "connection failed");
          console.error(`\x1b[31merror\x1b[0m: cross-node wake failed for ${targetNode}:${bareAgent}: ${underlying}`);
          console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
          process.exit(1);
        }
      }
      // peer not in namedPeers → fall through; resolveTarget will surface the routing error.
    }
  }

  // --- Unified resolution via resolveTarget (#201) ---
  const result = resolveTarget(query, config, sessions);

  // --- Consent gate (#644 Phase 1, opt-in via MAW_CONSENT=1) ---
  // Local + self-node sends are never gated. Cross-node hey to a peer that
  // hasn't approved (myNode → peerNode : hey) yet returns a request id +
  // PIN; user relays PIN OOB, peer runs `maw consent approve <id> <pin>`,
  // re-runs hey. After first approval, trust.json bypasses the gate.
  if (process.env.MAW_CONSENT === "1") {
    const { maybeGateConsent } = await import("../../core/consent/gate");
    const myNode = config.node ?? "local";
    const decision = await maybeGateConsent({ myNode, resolved: result, query, message });
    if (!decision.allow) {
      if (decision.message) console.error(decision.message);
      process.exit(decision.exitCode ?? 1);
    }
  }

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
      // #405: idle guard — abort if user has in-progress input on the prompt line
      let idleCheck = await checkPaneIdle(target);
      if (!idleCheck.idle) {
        await Bun.sleep(500);
        idleCheck = await checkPaneIdle(target);
        if (!idleCheck.idle) {
          console.error(`\x1b[31merror\x1b[0m: pane ${target} is not idle — user appears to be typing: "${idleCheck.lastInput.slice(0, 60)}"`);
          console.error(`\x1b[33mhint\x1b[0m:  use \x1b[36m--force\x1b[0m to send anyway`);
          process.exit(1);
        }
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
      from: "auto", // #804 Step 4 SIGN — sign cross-node /api/send
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
    const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
    console.error(`\x1b[31merror\x1b[0m: Remote fetch failed for peer ${result.peerUrl} (${result.node}): ${underlying}`);
    console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
    process.exit(1);
  }

  // Fallback: async peer discovery (network scan — slow path).
  // Only reached when resolveTarget found no local session AND no config-mapped peer.
  // Local sessions were already checked above — if we reach here, local genuinely missed.
  const peerUrl = await findPeerForTarget(query, sessions);
  if (peerUrl) {
    const res = await curlFetch(`${peerUrl}/api/send`, {
      method: "POST",
      body: JSON.stringify({ target: query, text: message }),
      from: "auto", // #804 Step 4 SIGN — sign discovery-fallback /api/send
    });
    if (res.ok && res.data?.ok) {
      console.log(`\x1b[32mdelivered\x1b[0m ⚡ ${peerUrl} → ${res.data.target || query}: ${message}`);
      if (res.data.lastLine) console.log(`\x1b[90m  ⤷ ${res.data.lastLine.slice(0, cfgLimit("messageTruncate"))}\x1b[0m`);
      await runHook("after_send", { to: query, message });
      return;
    }
    // Remote fetch was attempted but failed — surface the remote failure explicitly (#411).
    // Never fall through to "not found in local sessions" when the real problem is network.
    const underlying = res.data?.error || (res.status ? `HTTP ${res.status}` : "connection failed");
    console.error(`\x1b[31merror\x1b[0m: Remote fetch failed for peer ${peerUrl}: ${underlying}`);
    console.error(`\x1b[33mhint\x1b[0m:  check peer connectivity: maw health`);
    process.exit(1);
  }

  // Local-only miss — no network was attempted (#411). Show resolver's own detail.
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
