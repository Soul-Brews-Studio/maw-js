import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { cmdSend } from "../commands/shared/comm";
import { UserError } from "../core/util/user-error";
import { formatError } from "../lib/format-error";

// #1149 — `--inbox` mode writes directly to Claude Code's teammate inbox file
// (`~/.claude/teams/<team>/inboxes/<agent>.json`) instead of injecting via
// tmux send-keys. Claude Code's useInboxPoller (1Hz) picks up the message and
// wraps it in `<teammate-message>` XML for the recipient's conversation.
//
// No proper-lockfile: respects maw-js's documented file-system-race stance
// (docs/security/file-system-race-stance.md) — PRIVATE-PATH inboxes are
// effectively single-writer per agent at any given moment.
function writeInboxMessage(teamName: string, agentName: string, from: string, text: string): string {
  const inboxDir = join(homedir(), ".claude/teams", teamName, "inboxes");
  const inboxPath = join(inboxDir, `${agentName}.json`);
  mkdirSync(inboxDir, { recursive: true });
  let messages: unknown[] = [];
  if (existsSync(inboxPath)) {
    try { messages = JSON.parse(readFileSync(inboxPath, "utf-8")); } catch { messages = []; }
  }
  // Claude Code's TeammateMessage schema: { from, text, timestamp, read, color?, summary? }
  // text is PLAIN — Claude wraps it in <teammate-message> for the conversation.
  messages.push({
    from,
    text,
    summary: text.slice(0, 80),
    timestamp: new Date().toISOString(),
    read: false,
  });
  // lgtm[js/file-system-race] — PRIVATE-PATH: inbox under ~/.claude/teams/<team>/inboxes/, see docs/security/file-system-race-stance.md
  writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
  return inboxPath;
}

export async function routeComm(cmd: string, args: string[]): Promise<boolean> {
  // hey stays core — it's the transport layer.
  // Note: `send` and `tell` were previously aliases here; `send` is now the
  // raw-text plugin (#757), and `tell` was undocumented. Use `maw hey` for
  // agent messaging.
  if (cmd === "hey") {
    const force = args.includes("--force");
    // #842 Sub-C — `--approve` bypasses the cross-scope ACL queue gate.
    // Operator-explicit opt-in for THIS message; mirrors the consent
    // `--pin` escape hatch already wired in #644. Optional `--trust`
    // pairs with `--approve` to also persist the sender↔target trust
    // entry so the same pair stops queuing on subsequent sends.
    const approve = args.includes("--approve");
    const trust = args.includes("--trust");

    // #1149 — `--inbox` short-circuits to file-based teammate inbox write
    const inboxFlag = args.includes("--inbox");
    const teamIdx = args.indexOf("--team");
    const teamName = teamIdx > -1 && args[teamIdx + 1] ? args[teamIdx + 1] : process.env.CLAUDE_CODE_TEAM_NAME;
    const fromIdx = args.indexOf("--from");
    const fromTag = fromIdx > -1 && args[fromIdx + 1] ? args[fromIdx + 1] : "[maw-hey]";

    const target = args[1];
    const msgArgs = args
      .slice(2)
      .filter((a, i, arr) => {
        if (["--force", "--approve", "--trust", "--inbox"].includes(a)) return false;
        if (a === "--team" || a === "--from") return false;
        // skip the value following --team/--from
        if (i > 0 && (arr[i - 1] === "--team" || arr[i - 1] === "--from")) return false;
        return true;
      });

    // Distinguish: zero-args usage error vs missing-message error (#388.3)
    // A user who typed `maw hey mawjs` (just the target, no message) was
    // previously indistinguishable from `maw hey` alone — both hit the
    // same "usage:" error. Now the missing-message case names the target
    // so the user sees their input got through.
    if (!target) {
      console.error("usage: maw hey <target> <message> [--force] [--approve] [--trust]");
      console.error("  target forms (#759 Phase 2 — bare names removed):");
      console.error("    local:<agent>                this node");
      console.error("    <node>:<session>             canonical cross-node form (window 1)");
      console.error("    <node>:<session>:<window>    target a specific tmux window (#410)");
      console.error("  e.g. maw hey local:mawjs \"hello from neo\"");
      console.error("       maw hey phaith:01-hojo:3 \"hello hojo-hermes\"");
      console.error("       run `maw locate <agent>` to enumerate across federation");
      throw new UserError("missing target and message");
    }
    if (!msgArgs.length) {
      console.error(formatError(
        `missing message for target '${target}'`,
        `maw hey ${target} <message>  (if '${target}' isn't a valid target, run 'maw ls' to see available ones)`,
      ));
      throw new UserError(`missing message for '${target}'`);
    }

    // #1149 — `--inbox` mode: write to Claude Code's teammate inbox
    // (target = bare agent-name; --team is required since there's no node:agent
    //  semantics for inbox writes — single-host file IPC)
    if (inboxFlag) {
      if (!teamName) {
        console.error(formatError(
          `--inbox requires --team <name> or CLAUDE_CODE_TEAM_NAME env`,
          `maw hey <agent> <message> --inbox --team <team-name>`,
        ));
        throw new UserError("--inbox missing --team");
      }
      const path = writeInboxMessage(teamName, target, fromTag, msgArgs.join(" "));
      // Format mirrors federation's "delivered → <session>:<pane>" so operators
      // can distinguish transport at a glance. (inbox mode) tag = file IPC, not tmux.
      console.log(`\x1b[32mdelivered\x1b[0m → ${path} \x1b[90m(inbox mode)\x1b[0m`);
      console.log(`\x1b[90m  ⤷ Claude Code's useInboxPoller (1Hz) will wrap as <teammate-message>\x1b[0m`);
      return true;
    }

    await cmdSend(target, msgArgs.join(" "), force, { approve, trust });
    return true;
  }
  return false;
}
