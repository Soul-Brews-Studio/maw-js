import { listSessions, hostExec, tmuxCmd } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";
import {
  PANE_TARGET_FORMAT,
  resolvePaneTargetFromListPanesOutput,
} from "../../../commands/shared/pane-target-resolver";

export interface KillOpts {
  /** Pane index — narrows kill to a specific pane of the resolved window. */
  pane?: number;
  /** Window index — disambiguates duplicate window names. */
  index?: number;
  /** Kill every window whose name matches the requested window. */
  all?: boolean;
}

type KillWindowInfo = { index?: number; name?: string };

function windowLabel(w: KillWindowInfo): string {
  const index = Number.isInteger(w.index) ? String(w.index) : "?";
  const name = w.name || "(unnamed)";
  return `${index}:${name}`;
}

function parseWindowIndex(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function matchingWindowIndexes(
  sessionName: string,
  windows: KillWindowInfo[],
  rawWindow: string,
  opts: KillOpts,
): number[] {
  const optIndex = parseWindowIndex(opts.index);
  if (opts.index !== undefined && optIndex === undefined) throw new Error(`--index must be a non-negative integer (got ${String(opts.index)})`);
  if (opts.all && optIndex !== undefined) throw new Error("cannot combine --all and --index");
  if (opts.all && opts.pane !== undefined) throw new Error("cannot combine --all and --pane");

  if (optIndex !== undefined) {
    const hit = windows.find(w => w.index === optIndex);
    if (!hit) {
      const valid = windows.map(windowLabel).join(", ") || "(none)";
      throw new Error(`window index ${optIndex} does not exist in session ${sessionName} (valid: ${valid})`);
    }
    return [optIndex];
  }

  if (!rawWindow) return [];

  // Preserve long-standing shorthand: session:2 means window index 2.
  if (/^\d+$/.test(rawWindow)) {
    const index = Number.parseInt(rawWindow, 10);
    const hit = windows.find(w => w.index === index);
    if (!hit) {
      const valid = windows.map(windowLabel).join(", ") || "(none)";
      throw new Error(`window index ${index} does not exist in session ${sessionName} (valid: ${valid})`);
    }
    return [index];
  }

  const requested = rawWindow.toLowerCase();
  const matches = windows.filter(w => (w.name || "").toLowerCase() === requested);
  if (matches.length === 0) {
    const valid = windows.map(windowLabel).join(", ") || "(none)";
    throw new Error(`window '${rawWindow}' not found in session ${sessionName} (valid: ${valid})`);
  }
  if (matches.length > 1 && !opts.all) {
    const lines = matches.map(w => `    • ${windowLabel(w)}`).join("\n");
    throw new Error(
      `window '${rawWindow}' is ambiguous in session ${sessionName} — matches ${matches.length} windows:\n` +
      `${lines}\n  use --index N to kill one, or --all to kill all matching windows`,
    );
  }
  return matches
    .map(w => w.index)
    .filter((index): index is number => Number.isInteger(index));
}

/**
 * maw kill <target>[:window] [--pane N] [--index N|--all]
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
    console.error("usage: maw kill <target>[:window] [--pane N] [--index N|--all]");
    console.error("  e.g. maw kill mawjs");
    console.error("       maw kill mawjs:0");
    console.error("       maw kill mawjs --pane 1");
    throw new Error("usage: maw kill <target>[:window] [--pane N] [--index N|--all]");
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

  const windowIndexes = matchingWindowIndexes(session, r.match.windows ?? [], rawWindow, opts);

  // --pane requires a window, bare session kill does not
  if (opts.pane !== undefined) {
    // Default to the first window if no window/index given.
    const win = windowIndexes[0] ?? r.match.windows[0]?.index ?? 0;
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

  if (rawWindow || opts.index !== undefined || opts.all) {
    if (windowIndexes.length === 0) {
      throw new Error(opts.all ? "--all requires a window name target (session:window)" : "window target required");
    }
    const killed: string[] = [];
    for (const index of windowIndexes) {
      const win = `${session}:${index}`;
      try {
        await hostExec(`${tmux} kill-window -t '${win}'`);
        killed.push(win);
      } catch (e: any) {
        throw new Error(`kill-window failed: ${e.message || e}`);
      }
    }
    if (killed.length === 1) {
      console.log(`  \x1b[32m✓\x1b[0m killed window ${killed[0]}`);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m killed ${killed.length} windows ${killed.join(", ")}`);
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
