import { listSessions, hostExec, tmuxCmd } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";

export interface ZoomOpts {
  /** Pane index within the resolved window. Default: current/first. */
  pane?: number;
}

/**
 * maw zoom <target> [--pane N]
 *
 * Toggle zoom state of a pane (full-screen that pane within its window).
 * Wraps `tmux resize-pane -Z` — idempotent toggle, same key-binding
 * behavior as prefix + z in interactive tmux.
 */
export async function cmdZoom(target: string, opts: ZoomOpts = {}) {
  if (!target) {
    throw new Error("usage: maw zoom <target> [--pane N]\n  e.g. maw zoom mawjs\n       maw zoom neo:0 --pane 1");
  }

  let resolved: string;
  if (target.includes(":")) {
    const [rawSession, rest] = target.split(":", 2);
    const sessions = await listSessions();
    const r = resolveSessionTarget(rawSession, sessions);
    if (r.kind === "ambiguous") {
      console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${r.candidates.length} sessions:`);
      for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      throw new Error(`'${rawSession}' is ambiguous — matches ${r.candidates.length} sessions`);
    }
    if (r.kind === "none") {
      if (r.hints && r.hints.length > 0) {
        console.error(`  \x1b[90m  did you mean:\x1b[0m`);
        for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      }
      throw new Error(`session '${rawSession}' not found`);
    }
    resolved = `${r.match.name}:${rest}`;
  } else {
    const sessions = await listSessions();
    const r = resolveSessionTarget(target, sessions);
    if (r.kind === "ambiguous") {
      console.error(`  \x1b[31m✗\x1b[0m '${target}' is ambiguous — matches ${r.candidates.length} sessions:`);
      for (const s of r.candidates) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      throw new Error(`'${target}' is ambiguous — matches ${r.candidates.length} sessions`);
    }
    if (r.kind === "none") {
      if (r.hints && r.hints.length > 0) {
        console.error(`  \x1b[90m  did you mean:\x1b[0m`);
        for (const s of r.hints) console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      } else {
        console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
      }
      throw new Error(`session '${target}' not found`);
    }
    resolved = `${r.match.name}:${r.match.windows[0]?.index ?? 0}`;
  }

  const paneSuffix = opts.pane !== undefined ? `.${opts.pane}` : "";
  const full = resolved + paneSuffix;
  const tmux = tmuxCmd();

  try {
    await hostExec(`${tmux} resize-pane -Z -t '${full}'`);
    console.log(`  \x1b[32m✓\x1b[0m toggled zoom on ${full}`);
  } catch (e: any) {
    throw new Error(`zoom failed: ${e.message || e}`);
  }
}
