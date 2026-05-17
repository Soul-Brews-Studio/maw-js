/**
 * comm-list.ts — cmdList + renderSessionName + orphan detection.
 *
 * #957 contract: cmdList is strictly READ-ONLY on tmux state. It must
 * never call `tmux new-session` (vanilla or grouped `-t <parent>` form),
 * `kill-session`, `kill-window`, `send-keys`, or any other mutating tmux
 * subcommand — only `list-sessions`, `list-windows`, `list-panes`, and
 * non-tmux helpers (`find`, `git worktree list` via scanWorktrees).
 * Regression test: test/isolated/cmd-list-no-new-session-957.test.ts.
 */

import {
  listSessions as defaultListSessions,
  getPaneInfos as defaultGetPaneInfos,
  scanWorktrees as defaultScanWorktrees,
  cleanupWorktree as defaultCleanupWorktree,
  isAgentCommand as defaultIsAgentCommand,
} from "../../sdk";

type LatestSnapshot = {
  timestamp: string;
  sessions: Array<{ name: string }>;
};

export interface CommListDeps {
  listSessions?: typeof defaultListSessions;
  getPaneInfos?: typeof defaultGetPaneInfos;
  scanWorktrees?: typeof defaultScanWorktrees;
  cleanupWorktree?: typeof defaultCleanupWorktree;
  isAgentCommand?: typeof defaultIsAgentCommand;
  latestSnapshot?: () => LatestSnapshot | null;
  log?: Pick<Console, "log" | "error">;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

function commListDeps(deps: CommListDeps) {
  return {
    listSessions: deps.listSessions ?? defaultListSessions,
    getPaneInfos: deps.getPaneInfos ?? defaultGetPaneInfos,
    scanWorktrees: deps.scanWorktrees ?? defaultScanWorktrees,
    cleanupWorktree: deps.cleanupWorktree ?? defaultCleanupWorktree,
    isAgentCommand: deps.isAgentCommand ?? defaultIsAgentCommand,
    latestSnapshot: deps.latestSnapshot,
    log: deps.log ?? console,
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
  };
}

async function loadLatestSnapshot(depsLatestSnapshot?: () => LatestSnapshot | null): Promise<LatestSnapshot | null> {
  if (depsLatestSnapshot) return depsLatestSnapshot();
  const { latestSnapshot } = await import("../../core/fleet/snapshot");
  return latestSnapshot();
}

/**
 * #359 — render a session header line for `maw ls`.
 * View sessions (`*-view` suffix or the `maw-view` meta-session — see
 * team/impl.ts:264) render dimmed with a trailing `[view]` tag; source
 * sessions stay bright cyan. Pure function, exported for tests.
 */
export function renderSessionName(name: string): string {
  const isView = /-view$/.test(name) || name === "maw-view";
  return isView
    ? `\x1b[90m${name}\x1b[0m \x1b[90m[view]\x1b[0m`
    : `\x1b[36m${name}\x1b[0m`;
}

/**
 * #957 — `*-view-diag` sessions are diagnostic shadows produced by
 * external tooling (extracted view plugin, doctor flows). They share
 * panes with their parent so listing them surfaces nothing the user
 * doesn't already see under the source session — and they pollute the
 * output. Hide them from `maw ls`. The plain `*-view` suffix still
 * renders (with the [view] tag) since users actively reattach to those.
 */
function isViewDiag(name: string): boolean {
  return /-view-diag$/.test(name);
}

/**
 * `maw ls` — list active oracle sessions and orphaned worktrees.
 *
 * @param opts.fix  When true, after listing, prune any orphaned/stale
 *                  worktrees via cleanupWorktree() and print a summary.
 *                  Threaded from the alias-dispatch path
 *                  (src/cli/top-aliases.ts → invokeDirectHandler).
 */
export async function cmdList(opts: { fix?: boolean } = {}, deps: CommListDeps = {}) {
  const d = commListDeps(deps);
  const rawSessions = await d.listSessions();
  const sessions = rawSessions.filter(s => !isViewDiag(s.name));

  // Batch-check process + cwd for each pane
  const targets: string[] = [];
  for (const s of sessions) {
    for (const w of s.windows) targets.push(`${s.name}:${w.index}`);
  }
  const infos = await d.getPaneInfos(targets);

  for (const s of sessions) {
    d.log.log(renderSessionName(s.name));
    for (const w of s.windows) {
      const target = `${s.name}:${w.index}`;
      const info = infos[target] || { command: "", cwd: "" };
      const isAgent = d.isAgentCommand(info.command);
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
      d.log.log(`  ${dot} ${w.index}: ${w.name}${suffix}`);
    }
  }

  // Detect orphaned worktree directories (on disk but no tmux window)
  let orphans: Awaited<ReturnType<typeof defaultScanWorktrees>> = [];
  try {
    const worktrees = await d.scanWorktrees();
    orphans = worktrees.filter(wt => wt.status === "stale" || wt.status === "orphan");
    if (orphans.length > 0) {
      d.log.log("");
      for (const wt of orphans) {
        const dirName = wt.path.split("/").pop() || wt.name;
        const label = wt.status === "orphan" ? "orphaned (prunable)" : "no tmux window";
        d.log.log(`  \x1b[33m⚠ orphaned:\x1b[0m ${dirName} \x1b[90m(${label})\x1b[0m`);
      }
      d.log.log("");
      if (!opts.fix) {
        d.log.log(`\x1b[90m  → maw ls --fix       to prune orphans\x1b[0m`);
      }
    }
  } catch (e: any) {
    // Don't crash maw ls on scan failure (non-critical) — but surface the error in debug mode
    // so silent failures have a diagnosable cause.
    if (d.env.MAW_DEBUG) {
      d.log.error(`\x1b[33m⚠ maw ls: scanWorktrees failed (non-fatal): ${e?.message || e}\x1b[0m`);
    }
  }

  if (sessions.length === 0 && orphans.length === 0) {
    d.log.log("\x1b[90mNo active sessions.\x1b[0m");

    try {
      const snap = await loadLatestSnapshot(d.latestSnapshot);
      if (snap) {
        const ageMs = d.now() - new Date(snap.timestamp).getTime();
        if (ageMs < 24 * 60 * 60 * 1000) {
          const mins = Math.round(ageMs / 60000);
          const ageStr = mins >= 60 ? `${Math.round(mins / 60)}h ago` : `${mins}m ago`;
          d.log.log(`\n\x1b[36m📸\x1b[0m Last snapshot (${ageStr}):`);
          for (const s of snap.sessions) d.log.log(`   \x1b[33m${s.name}\x1b[0m`);
          d.log.log(`\n\x1b[90m  → maw fleet restore --all   wake all from snapshot\x1b[0m`);
        }
      }
    } catch {}

    d.log.log("\x1b[90m  → maw bud <name>     create new oracle\x1b[0m");
    d.log.log("\x1b[90m  → maw wake <name>    attach existing\x1b[0m");
  }

  // --fix — prune orphans we just listed. Calls cleanupWorktree() per
  // entry; same surface that `maw fleet` flows already use, so behavior
  // matches user expectations from existing maintenance commands.
  // Read-only contract above is preserved when --fix is absent (default).
  if (opts.fix && orphans.length > 0) {
    d.log.log("");
    d.log.log(`\x1b[36m→ pruning ${orphans.length} orphan${orphans.length === 1 ? "" : "s"}…\x1b[0m`);
    let pruned = 0;
    for (const wt of orphans) {
      const dirName = wt.path.split("/").pop() || wt.name;
      try {
        const log = await d.cleanupWorktree(wt.path);
        d.log.log(`  \x1b[32m✓\x1b[0m ${dirName}`);
        for (const line of log) d.log.log(`    \x1b[90m${line}\x1b[0m`);
        pruned++;
      } catch (e: any) {
        d.log.log(`  \x1b[31m✗\x1b[0m ${dirName} \x1b[90m(${e?.message || e})\x1b[0m`);
      }
    }
    d.log.log("");
    d.log.log(`\x1b[90m  pruned ${pruned}/${orphans.length}\x1b[0m`);
  } else if (opts.fix && orphans.length === 0) {
    d.log.log("");
    d.log.log(`\x1b[90m  → nothing to prune\x1b[0m`);
  }
}
