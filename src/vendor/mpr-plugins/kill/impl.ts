import { listSessions, hostExec, tmuxCmd } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";
import {
  PANE_TARGET_FORMAT,
  resolvePaneTargetFromListPanesOutput,
} from "../../../commands/shared/pane-target-resolver";

export interface KillOpts {
  /** Pane index — narrows kill to a specific pane of the resolved window. */
  pane?: number;
}

/**
 * maw kill <target>[:window] [--pane N]
 *
 * Trust the user — if they typed it, they meant it. No --force gate.
 *
 *   maw kill <session>            → kill whole session
 *   maw kill <session>:<window>   → kill that window
 *   maw kill <target> --pane N    → kill pane N of target window
 *
 * Target resolution mirrors maw split: bare session names go through the
 * canonical `resolveSessionTarget` matcher. Silent wrong-answer is worse
 * than a loud failure.
 */
export async function cmdKill(target: string, opts: KillOpts = {}) {
  if (!target) {
    console.error("usage: maw kill <target>[:window] [--pane N]");
    console.error("  e.g. maw kill mawjs");
    console.error("       maw kill mawjs:0");
    console.error("       maw kill mawjs --pane 1");
    throw new Error("usage: maw kill <target>[:window] [--pane N]");
  }

  const [rawSession, rawWindow] = target.includes(":")
    ? target.split(":", 2)
    : [target, ""];

  // Resolve bare session name against live fleet
  const sessions = await listSessions();
  const r = resolveSessionTarget(rawSession, sessions);

  if (r.kind === "ambiguous") {
    console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${r.candidates.length} sessions:`);
    for (const s of r.candidates) {
      console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
    }
    console.error(`  \x1b[90m  use the full name: maw kill <exact-session>\x1b[0m`);
    throw new Error(`'${rawSession}' is ambiguous`);
  }
  if (r.kind === "none") {
    if (!rawWindow && opts.pane === undefined) {
      const paneRaw = await hostExec(`${tmuxCmd()} list-panes -a -F '${PANE_TARGET_FORMAT}'`).catch(() => "");
      if (paneRaw.trim()) {
        const paneHit = resolvePaneTargetFromListPanesOutput(rawSession, paneRaw);
        if (paneHit.kind === "match") {
          const pane = paneHit.candidate.resolved;
          await hostExec(`${tmuxCmd()} kill-pane -t '${pane}'`);
          console.log(
            `  \x1b[32m✓\x1b[0m killed pane ${rawSession} → ${pane} ` +
            `\x1b[90m[${paneHit.candidate.source} (${paneHit.candidate.name})]\x1b[0m`,
          );
          return;
        }
        if (paneHit.kind === "ambiguous") {
          console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${paneHit.candidates.length} panes:`);
          for (const candidate of paneHit.candidates) {
            console.error(
              `  \x1b[90m    • ${candidate.name} → ${candidate.resolved}` +
              `${candidate.target ? ` (${candidate.target})` : ""} [${candidate.source}]\x1b[0m`,
            );
          }
          console.error(`  \x1b[90m  use the pane id or full session:window.pane target\x1b[0m`);
          throw new Error(`'${rawSession}' is ambiguous`);
        }
      }
    }
    console.error(`  \x1b[31m✗\x1b[0m session '${rawSession}' not found`);
    if (r.hints && r.hints.length > 0) {
      console.error(`  \x1b[90m  did you mean:\x1b[0m`);
      for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
    } else {
      console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
    }
    throw new Error(`session '${rawSession}' not found`);
  }

  const session = r.match.name;
  const tmux = tmuxCmd();

  // --pane requires a window, bare session kill does not
  if (opts.pane !== undefined) {
    // Default to window 0 if no window given
    const win = rawWindow || String(r.match.windows[0]?.index ?? 0);
    const winTarget = `${session}:${win}`;
    const paneIndexesRaw = await hostExec(
      `${tmux} list-panes -t '${winTarget}' -F '#{pane_index}'`,
    ).catch((e: any) => {
      throw new Error(`list-panes failed for ${winTarget}: ${e?.message || e}`);
    });
    const validPaneIndexes = paneIndexesRaw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n));

    if (!validPaneIndexes.includes(opts.pane)) {
      const valid = validPaneIndexes.length
        ? validPaneIndexes.join(", ")
        : "(none)";
      throw new Error(`pane ${opts.pane} does not exist in window ${winTarget} (valid: ${valid})`);
    }

    const pane = `${session}:${win}.${opts.pane}`;
    try {
      await hostExec(`${tmux} kill-pane -t '${pane}'`);
      console.log(`  \x1b[32m✓\x1b[0m killed pane ${pane}`);
    } catch (e: any) {
      throw new Error(`kill-pane failed: ${e.message || e}`);
    }
    return;
  }

  if (rawWindow) {
    const win = `${session}:${rawWindow}`;
    try {
      await hostExec(`${tmux} kill-window -t '${win}'`);
      console.log(`  \x1b[32m✓\x1b[0m killed window ${win}`);
    } catch (e: any) {
      throw new Error(`kill-window failed: ${e.message || e}`);
    }
    return;
  }

  try {
    await hostExec(`${tmux} kill-session -t '${session}'`);
    console.log(`  \x1b[32m✓\x1b[0m killed session ${session}`);
  } catch (e: any) {
    throw new Error(`kill-session failed: ${e.message || e}`);
  }
}
