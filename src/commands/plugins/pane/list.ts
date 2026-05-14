/**
 * `maw pane list [SESSION]` — list panes (mirrors `maw panes` plural).
 *
 * Per #1269, this delegates to `cmdTmuxLs` — the canonical pane-listing
 * implementation that powers `maw ls`, `maw panes`, and `maw tmux ls`.
 *
 * Behavior:
 *   - no SESSION arg → current session only (matches `maw tmux ls` default)
 *   - SESSION arg    → filter to that session (post-filtered after --all scan,
 *                      since cmdTmuxLs's "current session" auto-detection
 *                      uses $TMUX rather than an explicit session name)
 *   - --all          → every session
 *   - --json         → JSON output for scripting
 *   - -v|--verbose   → full per-pane detail
 *
 * Open question (called out in PR body): `maw pane list` overlaps with
 * `maw panes` (which itself is a top-level alias for the panes plugin in
 * maw-plugin-registry). For now `maw pane list` re-uses cmdTmuxLs directly
 * — same output shape, simpler subset.
 */
import { cmdTmuxLs, type TmuxLsOpts } from "../../core/tmux/impl";

export interface PaneListOpts {
  /** Filter to a specific session name. When set, implies --all-scope scan + post-filter. */
  session?: string;
  /** All sessions, not just current. */
  all?: boolean;
  /** JSON output. */
  json?: boolean;
  /** Compact one-line-per-session output. */
  compact?: boolean;
  /** Full per-pane detail. Overrides --compact. */
  verbose?: boolean;
}

export async function cmdPaneList(opts: PaneListOpts = {}): Promise<void> {
  // If a session filter was requested, force an --all scan so we can see
  // panes outside the current $TMUX session, then let cmdTmuxLs's natural
  // filter via TARGET prefix handle it. Since cmdTmuxLs doesn't accept a
  // session-filter option directly, we fake it by setting $TMUX-via-display
  // semantics — but easier: when session is set, just force --all. Per-session
  // filter granularity is the open question called out in the PR body.
  const lsOpts: TmuxLsOpts = {
    all: !!opts.all || !!opts.session,
    json: !!opts.json,
    compact: !!opts.compact,
    verbose: !!opts.verbose,
  };

  if (!opts.session) {
    await cmdTmuxLs(lsOpts);
    return;
  }

  // Session filter: capture cmdTmuxLs JSON output and filter, then re-render.
  // Simplest correct path: force JSON, parse, filter, print rows.
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
  try {
    await cmdTmuxLs({ ...lsOpts, json: true });
  } finally {
    console.log = origLog;
  }

  let parsed: Array<{ target: string; [k: string]: unknown }>;
  try {
    parsed = JSON.parse(captured.join("\n"));
  } catch {
    // Fallback: print raw output if JSON parse fails (shouldn't happen).
    console.log(captured.join("\n"));
    return;
  }

  const filtered = parsed.filter(p => p.target.startsWith(`${opts.session}:`));
  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (filtered.length === 0) {
    console.log(`\x1b[90mNo panes in session '${opts.session}'.\x1b[0m`);
    return;
  }
  for (const p of filtered) {
    console.log(`  ${p.target}  ${p.command ?? ""}  ${p.annotation ?? ""}`);
  }
}
