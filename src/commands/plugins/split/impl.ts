import { listSessions, hostExec } from "../../../sdk";

export interface SplitOpts {
  /** Split percentage (1-99). Default: 50. */
  pct?: number;
  /** Split vertical (top/bottom) instead of horizontal (side-by-side). */
  vertical?: boolean;
  /** Split without attaching — leaves a plain shell in the new pane. */
  noAttach?: boolean;
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
  if (!process.env.TMUX) {
    console.error("  \x1b[31m✗\x1b[0m maw split requires an active tmux session");
    process.exit(1);
  }

  if (!target) {
    console.error("usage: maw split <target> [--pct N] [--vertical] [--no-attach]");
    console.error("  e.g. maw split yeast");
    console.error("       maw split mawjs-view --pct 30 --vertical");
    process.exit(1);
  }

  // Validate pct early so bad input never reaches tmux
  const pct = opts.pct ?? 50;
  if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
    console.error(`  \x1b[31m✗\x1b[0m --pct must be 1-99 (got ${pct})`);
    process.exit(1);
  }

  // Resolve target to session:window if bare name given
  let resolved = target;
  if (!target.includes(":")) {
    const sessions = await listSessions();
    const match = sessions.find(
      s =>
        s.name === target ||
        s.name.endsWith(`-${target}`) ||
        s.name.toLowerCase() === target.toLowerCase(),
    );
    if (!match) {
      console.error(`  \x1b[31m✗\x1b[0m session '${target}' not found in fleet`);
      console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
      process.exit(1);
    }
    resolved = `${match.name}:${match.windows[0]?.index ?? 0}`;
  }

  // Build tmux split-window command.
  //
  // Critical: unset $TMUX in the spawned shell so the inner attach-session
  // can nest into the target. Without `TMUX=`, tmux refuses nested attach
  // and the new pane dies immediately (this is the #bud --split silent-fail bug).
  const direction = opts.vertical ? "-v" : "-h";
  const innerCmd = opts.noAttach ? "bash" : `TMUX= tmux attach-session -t ${resolved}`;
  const cmd = `tmux split-window ${direction} -l ${pct}% "${innerCmd}"`;

  try {
    await hostExec(cmd);
    const side = opts.vertical ? "below" : "beside";
    const action = opts.noAttach ? "empty pane" : resolved;
    console.log(`  \x1b[32m✓\x1b[0m split ${side} — ${action} (${pct}%)`);
  } catch (e: any) {
    console.error(`  \x1b[31m✗\x1b[0m split failed: ${e.message || e}`);
    process.exit(1);
  }
}
