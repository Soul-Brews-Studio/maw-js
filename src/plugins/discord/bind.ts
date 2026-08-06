/**
 * `maw discord bind <bot> [--apply] [--restart] [--session <name>]`
 *
 * End-to-end Discord-online for a bot ON THIS HOST. Codifies the manual
 * pattern proven 3 times (odin + digger on m5, xiaoer on white):
 *
 *   1. Pre-flight: token in pass, state-dir, repo via ghq, REST 200, not-already-online
 *   2. Spawn tmux session (default name: <bot>-discord)
 *   3. Inject env (DISCORD_STATE_DIR + token from pass)
 *   4. Launch `claude --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official`
 *   5. Wait + verify "Listening for channel messages" marker
 *   6. Verify bun discord/0.0.4 process holds matching DISCORD_STATE_DIR
 *
 * Safety (per side-effect-verb-checklist + telegraph-destructive-tmux):
 *   - DRY-RUN by default — shows plan, no writes
 *   - --apply required to execute
 *   - If bot already online → refuse without --restart (which adds telegraph + kill)
 *   - --restart pre-checks attached clients; refuses if any (forces detach first)
 *
 * v0.3 scope: SINGLE-HOST (this host). Cross-host wake in v0.4.
 */
import { hostExec } from "maw-js/sdk";
import {
  listPassTokens, decryptToken, pingDiscord,
  findLegacyStateDir, findGhqPath, findOnlineBunForBot,
} from "./lib";

interface BindOpts {
  bot: string;
  apply: boolean;
  restart: boolean;
  session?: string;
  force: boolean;
}

interface PreflightResult {
  ok: boolean;
  rows: { check: string; status: "ok" | "warn" | "fail"; detail: string }[];
  tokenName?: string;
  stateDir?: string;
  repoPath?: string;
  online?: Awaited<ReturnType<typeof findOnlineBunForBot>>;
  attachedClients?: string;
}

function parseOpts(args: string[]): BindOpts {
  const positional = args.filter(a => !a.startsWith("--"));
  const sessionIdx = args.indexOf("--session");
  return {
    bot: positional[0] || "",
    apply: args.includes("--apply"),
    restart: args.includes("--restart"),
    session: sessionIdx !== -1 ? args[sessionIdx + 1] : undefined,
    force: args.includes("--force"),
  };
}

function sym(status: "ok" | "warn" | "fail"): string {
  return status === "ok" ? "✓" : status === "warn" ? "○" : "✗";
}

async function runPreflight(bot: string): Promise<PreflightResult> {
  const result: PreflightResult = { ok: true, rows: [] };

  // 1. Token in pass
  const tokens = listPassTokens();
  const tok = tokens.find(t => t.bot === bot);
  if (!tok) {
    result.rows.push({ check: "token in pass", status: "fail", detail: `no discord/${bot}-token in pass` });
    result.ok = false;
    return result;
  }
  result.tokenName = tok.name;
  result.rows.push({ check: "token in pass", status: "ok", detail: `discord/${tok.name}` });

  // 2. State-dir exists
  const stateDir = findLegacyStateDir(bot);
  if (!stateDir) {
    result.rows.push({ check: "state-dir", status: "fail", detail: `~/.claude/channels/${bot}/ missing` });
    result.ok = false;
    return result;
  }
  result.stateDir = stateDir;
  result.rows.push({ check: "state-dir", status: "ok", detail: stateDir });

  // 3. Repo via ghq
  const repo = await findGhqPath(bot);
  if (!repo) {
    result.rows.push({ check: "repo (ghq)", status: "warn", detail: `no ghq match for '${bot}' — will cwd to state-dir parent` });
    // Not fatal — can still run with state-dir as cwd
  } else {
    result.repoPath = repo;
    result.rows.push({ check: "repo (ghq)", status: "ok", detail: repo });
  }

  // 4. Discord REST 200
  const token = await decryptToken(tok.name);
  if (!token) {
    result.rows.push({ check: "Discord REST", status: "fail", detail: "decrypt failed" });
    result.ok = false;
    return result;
  }
  const ping = await pingDiscord(token);
  if (!ping.ok) {
    result.rows.push({ check: "Discord REST", status: "fail", detail: `${ping.status || "ERR"}` });
    result.ok = false;
    return result;
  }
  result.rows.push({ check: "Discord REST", status: "ok", detail: `200 — ${ping.username || "?"}` });

  // 5. Already online?
  const online = await findOnlineBunForBot(bot);
  if (online) {
    result.online = online;
    const where = online.tmuxSession ? `tmux ${online.tmuxSession}` : "(unknown tmux)";
    result.rows.push({
      check: "not already online",
      status: "fail",
      detail: `already online — bun pid ${online.bunPid} in ${where}`,
    });
    result.ok = false;
  } else {
    result.rows.push({ check: "not already online", status: "ok", detail: "no live Gateway for this token on this host" });
  }

  return result;
}

function emitPreflight(log: (s: string) => void, pre: PreflightResult): void {
  log("  pre-flight:");
  for (const row of pre.rows) {
    log(`    ${sym(row.status)} ${row.check.padEnd(22)} ${row.detail}`);
  }
}

function planSummary(opts: BindOpts, pre: PreflightResult): string[] {
  const session = opts.session || `${opts.bot}-discord`;
  const cwd = pre.repoPath || pre.stateDir!;
  return [
    `  plan:`,
    `    session   tmux new-session -d -s ${session} -c ${cwd}`,
    `    env       DISCORD_STATE_DIR=${pre.stateDir}`,
    `    env       DISCORD_BOT_TOKEN=$(pass show discord/${pre.tokenName})  [redacted]`,
    `    launch    claude --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official`,
    `    wait      12s for Gateway connect`,
    `    verify    "Listening for channel messages" marker + bun discord/0.0.4 with matching STATE_DIR`,
  ];
}

async function executeBind(log: (s: string) => void, opts: BindOpts, pre: PreflightResult): Promise<boolean> {
  const session = opts.session || `${opts.bot}-discord`;
  const cwd = pre.repoPath || pre.stateDir!;

  // Step 1: create tmux session
  log(`  + tmux new-session -d -s ${session} -c ${cwd}`);
  try {
    await hostExec(`tmux new-session -d -s ${session} -c ${cwd}`);
  } catch (e: any) {
    log(`  ✗ tmux session create failed: ${e?.message || e}`);
    return false;
  }

  // Step 2: inject env + claude via maw run (safety-hook compliant)
  const cmd = `export DISCORD_STATE_DIR=${pre.stateDir} && export DISCORD_BOT_TOKEN=$(pass show discord/${pre.tokenName}) && claude --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official`;
  log(`  + maw run ${session} <env-injection + claude --channels>`);
  try {
    await hostExec(`maw run ${session} ${JSON.stringify(cmd)} 2>&1 | tail -1`);
  } catch (e: any) {
    log(`  ✗ maw run failed: ${e?.message || e}`);
    return false;
  }

  // Step 3: wait + verify
  log(`  ⏳ waiting 12s for claude + Discord Gateway boot...`);
  await new Promise(r => setTimeout(r, 12000));

  // Step 4: check for Listening marker
  let listening = false;
  try {
    const peek = await hostExec(`tmux capture-pane -t ${session} -p 2>/dev/null | grep -c "Listening for channel messages" || true`);
    listening = parseInt(peek.trim(), 10) > 0;
  } catch { /* skip */ }
  log(`  ${listening ? "✓" : "✗"} "Listening for channel messages" marker ${listening ? "present" : "MISSING"}`);

  // Step 5: verify bun discord plugin process
  const online = await findOnlineBunForBot(opts.bot);
  if (online) {
    log(`  ✓ bun discord/0.0.4 running (pid ${online.bunPid}, tmux ${online.tmuxSession || "?"})`);
  } else {
    log(`  ✗ no bun discord/0.0.4 process found matching this bot's state-dir`);
  }

  return listening && !!online;
}

export const cmdBind = {
  async run(log: (s: string) => void, args: string[]): Promise<void> {
    const opts = parseOpts(args);

    if (!opts.bot) {
      log("usage: maw discord bind <bot> [--apply] [--restart] [--session <name>] [--force]");
      log("");
      log("  --apply      execute the plan (default: dry-run)");
      log("  --restart    if already online, telegraph + kill the existing session first");
      log("  --session    custom tmux session name (default: <bot>-discord)");
      log("  --force      override 'attached clients' check on --restart (yanks panes)");
      return;
    }

    log(`🪣 maw discord bind ${opts.bot}${opts.apply ? " --apply" : " (dry-run — pass --apply to execute)"}`);
    log("");

    const pre = await runPreflight(opts.bot);
    emitPreflight(log, pre);
    log("");

    // Handle --restart: if online + restart flag, telegraph + kill + treat as not-online
    if (pre.online && opts.restart) {
      log("  → --restart: pre-checking attached clients to existing session");
      const sess = pre.online.tmuxSession;
      if (sess) {
        const clients = await hostExec(`tmux list-clients -t ${sess} 2>/dev/null || true`);
        const clientCount = clients.split("\n").filter(Boolean).length;
        log(`    attached clients to '${sess}': ${clientCount}`);
        if (clientCount > 0 && !opts.force) {
          log(`  🛑 ${clientCount} client(s) attached to '${sess}' — refusing kill without --force`);
          log(`     detach first (Ctrl-b d in each terminal) and re-run, or add --force to yank panes`);
          return;
        }
        log(`  + tmux kill-session -t ${sess}`);
        if (opts.apply) {
          try { await hostExec(`tmux kill-session -t ${sess}`); } catch { /* maybe gone */ }
          log(`  ⏳ sleeping 3s for Gateway disconnect`);
          await new Promise(r => setTimeout(r, 3000));
          // Reset pre-flight state — we just killed the old one
          pre.online = null;
          // Remove the failing row
          pre.rows = pre.rows.filter(r => r.check !== "not already online");
          pre.rows.push({ check: "not already online", status: "ok", detail: "killed old session for restart" });
          pre.ok = pre.rows.every(r => r.status !== "fail");
        }
      }
    }

    if (!pre.ok) {
      log("");
      log("  ✗ pre-flight failed. fix the failing checks above and re-run.");
      if (pre.online && !opts.restart) {
        log("     to restart anyway, re-run with --restart (telegraphs + kills the existing session)");
      }
      return;
    }

    const plan = planSummary(opts, pre);
    for (const line of plan) log(line);
    log("");

    if (!opts.apply) {
      log("  ⓘ dry-run only — re-run with --apply to execute");
      return;
    }

    log("  🪝 executing...");
    log("");
    const success = await executeBind(log, opts, pre);
    log("");

    if (success) {
      log(`  🎯 ${opts.bot} is now ONLINE on Discord (session: ${opts.session || `${opts.bot}-discord`})`);
    } else {
      log(`  ⚠ bind completed but verification was incomplete. Check 'maw discord status ${opts.bot} --check' + tmux peek.`);
    }
  },
};
