import { listSessions, hostExec, withPaneLock } from "../../../sdk";
import { resolveSessionTarget } from "../../../core/matcher/resolve-target";
import { normalizeTarget } from "../../../core/matcher/normalize-target";
import { formatError } from "../../../lib/format-error";
import { isClaudeLikePane, callerPaneCarveRefusal } from "../tmux/safety";

export interface SplitOpts {
  /** Split percentage (1-99). Default: 50. */
  pct?: number;
  /** Split vertical (top/bottom) instead of horizontal (side-by-side). */
  vertical?: boolean;
  /** Split without attaching — leaves a plain shell in the new pane. */
  noAttach?: boolean;
  /** Serialize via the pane-creation lock + settle. Opt-in — only matters
   *  when another in-process caller may be spawning concurrently. */
  lock?: boolean;
  /** Settle delay after split when lock=true. Default: 200ms. */
  settleMs?: number;
  /** Pane-id / selector to split beside instead of $TMUX_PANE. Break the
   *  implicit active-pane-drift that caused fractal-split cascade (#545).
   *  Accepts: "%N" (pane id), "session:window.pane", or "session:window". */
  anchorPane?: string;
}

/**
 * maw split <target> [--pct N] [--vertical] [--no-attach]
 *
 * Split the current tmux pane and attach to a target session in the new pane.
 *
 * Target resolution:
 *   - "session:window"  → used as-is
 *   - "session"         → resolved to session:window[0]
 *   - bare oracle name  → finds session ending with "-<name>" or name === <name>
 *
 * Why this exists: `/bud --split` inlined this pattern, but (a) the nested
 * `tmux attach-session` silently fails when $TMUX is set, and (b) the logic
 * is useful beyond bud (worktree, pair-ops, debugging). Extracted here as
 * one canonical helper — future skills call `maw split` instead of duplicating
 * the tmux shell-out.
 */
export async function cmdSplit(target: string, opts: SplitOpts = {}) {
  // Canonicalize first — drop trailing `/`, `/.git`, `/.git/` tab-completion artifacts.
  // Safe for "session:window" form: nothing to strip unless the user adds a literal slash.
  target = normalizeTarget(target);
  if (!process.env.TMUX) {
    throw new Error("maw split requires an active tmux session");
  }

  if (!target) {
    console.error("usage: maw split <target> [--pct N] [--vertical] [--no-attach]");
    console.error("  e.g. maw split yeast");
    console.error("       maw split mawjs-view --pct 30 --vertical");
    throw new Error("usage: maw split <target> [--pct N] [--vertical] [--no-attach]");
  }

  // Validate pct early so bad input never reaches tmux
  const pct = opts.pct ?? 50;
  if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
    throw new Error(`--pct must be 1-99 (got ${pct})`);
  }

  // Foot-gun refusal (#1303): when `--no-attach` is used and no `--from`
  // anchor is supplied, the caller's own pane ($TMUX_PANE) is the implicit
  // anchor — meaning the caller's pane gets carved. If the caller is running
  // a claude-like process (Claude Code session), refuse outright. Carving
  // a live AI pane is almost never what the user wants; the user almost
  // certainly meant to spawn a peer shell, not slice their own session.
  //
  // Three escape hatches, all mentioned in the error message:
  //   - `maw shell <name>` — non-carve interactive shell (#1304)
  //   - `maw bg <name> "<cmd>"` — non-carve background command (#1304)
  //   - `--from <oracle>` — carve a different peer's pane intentionally
  if (opts.noAttach && !opts.anchorPane && process.env.TMUX_PANE) {
    let callerCmd: string | undefined;
    try {
      const out = await hostExec(
        `tmux display-message -p -t '${process.env.TMUX_PANE.replace(/'/g, "'\\''")}' '#{pane_current_command}'`,
      );
      callerCmd = out.trim();
    } catch {
      // If the lookup fails (rare — pane gone, tmux unreachable), skip the
      // gate rather than block legitimate splits. The bug we're guarding
      // against is the silent carve, not the rare lookup failure.
    }
    if (isClaudeLikePane(callerCmd)) {
      throw new Error(callerPaneCarveRefusal(process.env.TMUX_PANE, callerCmd));
    }
  }

  // Resolve target to session:window if bare name given. Resolution rules
  // (exact > suffix/prefix fuzzy > ambiguous > none) live in the canonical
  // matcher — silent wrong-answer is worse than a loud failure.
  let resolved = target;
  if (!target.includes(":")) {
    const sessions = await listSessions();
    const r = resolveSessionTarget(target, sessions);

    if (r.kind === "ambiguous") {
      console.error(formatError(
        `'${target}' is ambiguous — matches ${r.candidates.length} sessions`,
        `use the full name: maw split <exact-session>`,
      ));
      for (const s of r.candidates) {
        console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      }
      throw new Error(`'${target}' is ambiguous`);
    }
    if (r.kind === "none") {
      console.error(formatError(
        `session '${target}' not found in fleet`,
        r.hints?.length ? `did you mean ${r.hints.map(h => h.name).join(", ")}? (try: maw ls)` : `try: maw ls`,
      ));
      throw new Error(`session '${target}' not found in fleet`);
    }

    resolved = `${r.match.name}:${r.match.windows[0]?.index ?? 0}`;
  }

  // Build tmux split-window command.
  //
  // Critical: unset $TMUX in the spawned shell so the inner attach-session
  // can nest into the target. Without `TMUX=`, tmux refuses nested attach
  // and the new pane dies immediately (this is the #bud --split silent-fail bug).
  //
  // Target the caller's pane (#365 cascade fix): without -t, tmux splits
  // the currently-active pane — which shifts after the first split, causing
  // the second `maw bud <name> --split` from the same parent to silently
  // split the wrong pane (or noop visually). Explicit -t $TMUX_PANE anchors
  // every split to the caller's origin pane, so buds cascade instead of drifting.
  // Fallback: if TMUX_PANE isn't set (shouldn't happen — we checked $TMUX above,
  // and any pane inside tmux has TMUX_PANE set — but defend anyway), omit -t
  // and accept the pre-fix behavior.
  // Precedence: opts.anchorPane (explicit, from cmdView) > $TMUX_PANE (caller's
  // pane) > none. Explicit anchor breaks the active-pane-drift that caused
  // fractal-split cascade in #545/#546.
  const direction = opts.vertical ? "-v" : "-h";
  const innerCmd = opts.noAttach ? "bash" : `TMUX= tmux attach-session -t ${resolved}`;
  const anchor = opts.anchorPane ?? process.env.TMUX_PANE;
  const targetFlag = anchor ? `-t '${anchor.replace(/'/g, "'\\''")}' ` : "";
  const cmd = `tmux split-window ${targetFlag}${direction} -l ${pct}% "${innerCmd}"`;

  try {
    if (opts.lock) {
      // Serialize against other in-process pane spawns; settle before release
      // so tmux has a tick to register the new pane index.
      const settleMs = opts.settleMs ?? 200;
      await withPaneLock(async () => {
        await hostExec(cmd);
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      });
    } else {
      await hostExec(cmd);
    }
    const side = opts.vertical ? "below" : "beside";
    const action = opts.noAttach ? "empty pane" : resolved;
    const anchorLabel = opts.anchorPane ? ` (anchored at ${opts.anchorPane})` : "";
    console.log(`  \x1b[32m✓\x1b[0m split ${side} — ${action} (${pct}%)${anchorLabel}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`split failed: ${msg}`);
  }
}
