import { listSessions, hostExec, withPaneLock } from "maw-js/sdk";
import { resolveSessionTarget } from "maw-js/core/matcher/resolve-target";
import { normalizeTarget } from "maw-js/core/matcher/normalize-target";
import { isClaudeLikePane } from "../../../commands/plugins/tmux/safety";

export type ClaudePanePolicy = "split" | "background-tab" | "link-window" | "refuse";

export interface SplitPolicyInput {
  paneCurrentCommand?: string;
  noAttach?: boolean;
  requestedPolicy?: ClaudePanePolicy | string;
  forceSplit?: boolean;
}

export interface SplitPolicyDecision {
  action: ClaudePanePolicy;
  reason: "not-attaching" | "force-split" | "not-claude" | "claude-policy";
}

const CLAUDE_PANE_POLICIES = new Set<ClaudePanePolicy>([
  "split",
  "background-tab",
  "link-window",
  "refuse",
]);

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function backgroundAttachCommand(target: string): string {
  // Detached background tabs run a nested tmux client inside a fresh pane.
  // Clear/reset that pane before attach so stale redraw artifacts from the
  // caller are not mirrored into the new tab (#1816 live smear at cccbd33c).
  return `TMUX=; printf '\\033c'; clear 2>/dev/null || true; exec tmux attach-session -t ${shellArg(target)}`;
}

function validateClaudePanePolicy(value: unknown): ClaudePanePolicy | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !CLAUDE_PANE_POLICIES.has(value as ClaudePanePolicy)) {
    throw new Error(`--claude-pane-policy must be one of: ${[...CLAUDE_PANE_POLICIES].join(", ")}`);
  }
  return value as ClaudePanePolicy;
}

export function decideSplitPolicy(input: SplitPolicyInput): SplitPolicyDecision {
  const requestedPolicy = validateClaudePanePolicy(input.requestedPolicy);
  if (input.noAttach) return { action: "split", reason: "not-attaching" };
  if (input.forceSplit) return { action: "split", reason: "force-split" };
  if (!isClaudeLikePane(input.paneCurrentCommand)) return { action: "split", reason: "not-claude" };
  return { action: requestedPolicy ?? "background-tab", reason: "claude-policy" };
}

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
  /** Policy for Claude-like source panes. Default: background-tab. */
  claudePanePolicy?: ClaudePanePolicy | string;
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

  // Resolve target to session:window if bare name given. Resolution rules
  // (exact > suffix/prefix fuzzy > ambiguous > none) live in the canonical
  // matcher — silent wrong-answer is worse than a loud failure.
  let resolved = target;
  if (!target.includes(":")) {
    const sessions = await listSessions();
    const r = resolveSessionTarget(target, sessions);

    if (r.kind === "ambiguous") {
      console.error(`  \x1b[31m✗\x1b[0m '${target}' is ambiguous — matches ${r.candidates.length} sessions:`);
      for (const s of r.candidates) {
        console.error(`  \x1b[90m    • ${s.name}\x1b[0m`);
      }
      console.error(`  \x1b[90m  use the full name: maw split <exact-session>\x1b[0m`);
      throw new Error(`'${target}' is ambiguous`);
    }
    if (r.kind === "none") {
      console.error(`  \x1b[31m✗\x1b[0m session '${target}' not found in fleet`);
      if (r.hints?.length) {
        console.error(`  \x1b[90mdid you mean:\x1b[0m`);
        for (const h of r.hints) {
          console.error(`  \x1b[90m    • ${h.name}\x1b[0m`);
        }
      }
      console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
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
  const anchor = opts.anchorPane ?? process.env.TMUX_PANE;
  const requestedPolicy = validateClaudePanePolicy(opts.claudePanePolicy);
  const paneCurrentCommand = await readAnchorPaneCommand(anchor, opts.noAttach);
  const policy = decideSplitPolicy({
    paneCurrentCommand,
    noAttach: opts.noAttach,
    requestedPolicy,
    forceSplit: process.env.MAW_FORCE_SPLIT === "1" || process.env.MAW_ALLOW_CLAUDE_SPLIT === "1",
  });

  try {
    switch (policy.action) {
      case "split":
        await splitIntoPane(resolved, pct, opts, anchor);
        break;
      case "background-tab":
        await openBackgroundTab(resolved, opts, anchor);
        break;
      case "link-window":
        await linkWindowIntoSourceSession(resolved, opts, anchor);
        break;
      case "refuse":
        throw new Error(`refusing to split from Claude-like pane '${anchor}' (#1816); use --claude-pane-policy split, background-tab, or link-window`);
    }
  } catch (e: any) {
    throw new Error(`split failed: ${e.message || e}`);
  }
}

async function runWithOptionalLock(opts: SplitOpts, fn: () => Promise<void>): Promise<void> {
  if (opts.lock) {
    // Serialize against other in-process pane spawns; settle before release
    // so tmux has a tick to register the new pane index.
    const settleMs = opts.settleMs ?? 200;
    await withPaneLock(async () => {
      await fn();
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    });
    return;
  }
  await fn();
}

async function readAnchorPaneCommand(anchor: string | undefined, noAttach: boolean | undefined): Promise<string | undefined> {
  if (!anchor || noAttach) return undefined;
  try {
    const raw = await hostExec(`tmux display-message -p -t ${shellArg(anchor)} '#{pane_current_command}'`);
    return String(raw).trim();
  } catch {
    // Fail open: split preserved previous behavior when tmux cannot inspect the
    // source pane. The user can still force a non-split policy via callers that
    // pass an explicit policy after a successful probe.
    return undefined;
  }
}

async function readAnchorSession(anchor: string | undefined): Promise<string | null> {
  if (!anchor) return null;
  try {
    const raw = await hostExec(`tmux display-message -p -t ${shellArg(anchor)} '#{session_name}'`);
    const session = String(raw).trim();
    return session.length > 0 ? session : null;
  } catch {
    return null;
  }
}

async function bestEffortTmux(command: string): Promise<void> {
  try {
    await hostExec(command);
  } catch {
    // Best-effort repaint only: the user action already succeeded.
  }
}

async function refreshSourceClient(anchor: string | undefined): Promise<void> {
  if (anchor) {
    try {
      const raw = await hostExec(`tmux display-message -p -t ${shellArg(anchor)} '#{client_tty}'`);
      const client = String(raw).trim();
      if (client.length > 0) {
        // Full-client repaint plus a targeted status redraw. Keep this aligned
        // with wake-maybe-split so every background-tab caller gets the same
        // smear fix (#1816 live repro after cccbd33c).
        await bestEffortTmux(`tmux refresh-client -c -t ${shellArg(client)}`);
        await bestEffortTmux(`tmux refresh-client -S -t ${shellArg(client)}`);
        return;
      }
    } catch {
      // Fall through to global redraws.
    }
  }
  await bestEffortTmux("tmux refresh-client -c");
  await bestEffortTmux("tmux refresh-client -S");
}

async function repaintSourcePane(anchor: string | undefined): Promise<void> {
  if (!anchor) return;
  try {
    await hostExec(`tmux send-keys -R -t ${shellArg(anchor)} C-l`);
    await bestEffortTmux(`tmux clear-history -t ${shellArg(anchor)}`);
  } catch {
    // Keep going: the full-client refresh below is often the more important
    // part of clearing stale lower-half redraw artifacts.
  }
  await refreshSourceClient(anchor);
}

async function clearNewTabPane(target: string): Promise<void> {
  try {
    await hostExec(`tmux send-keys -R -t ${shellArg(target)} C-l`);
    await bestEffortTmux(`tmux clear-history -t ${shellArg(target)}`);
  } catch {
    // Best-effort repaint only: a failed clear must not hide the newly opened
    // background tab from the caller.
  }
}

function backgroundWindowName(target: string): string {
  const session = target.split(":")[0] || target;
  const targetWindow = target.split(":").slice(1).join(":") || session;
  return `split-${targetWindow}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "split";
}

async function splitIntoPane(resolved: string, pct: number, opts: SplitOpts, anchor: string | undefined): Promise<void> {
  const direction = opts.vertical ? "-v" : "-h";
  const innerCmd = opts.noAttach ? "bash" : `TMUX= tmux attach-session -t ${resolved}`;
  const targetFlag = anchor ? `-t ${shellArg(anchor)} ` : "";
  const cmd = `tmux split-window ${targetFlag}${direction} -l ${pct}% "${innerCmd}"`;
  await runWithOptionalLock(opts, () => hostExec(cmd));
  const side = opts.vertical ? "below" : "beside";
  const action = opts.noAttach ? "empty pane" : resolved;
  const anchorLabel = opts.anchorPane ? ` (anchored at ${opts.anchorPane})` : "";
  console.log(`  \x1b[32m✓\x1b[0m split ${side} — ${action} (${pct}%)${anchorLabel}`);
}

async function openBackgroundTab(resolved: string, opts: SplitOpts, anchor: string | undefined): Promise<void> {
  const destinationSession = await readAnchorSession(anchor);
  const destination = destinationSession ? `-t ${shellArg(`${destinationSession}:`)} ` : "";
  const innerCmd = backgroundAttachCommand(resolved);
  await repaintSourcePane(anchor);
  let openedWindow = "";
  await runWithOptionalLock(opts, async () => {
    const opened = await hostExec(`tmux new-window -P -F '#{window_id}' -d ${destination}-n ${shellArg(backgroundWindowName(resolved))} ${shellArg(innerCmd)}`);
    openedWindow = String(opened).trim();
  });
  if (openedWindow.length > 0) await clearNewTabPane(openedWindow);
  if (anchor) {
    await repaintSourcePane(anchor);
  }
  console.log(`  \x1b[32m✓\x1b[0m opened background tab — ${resolved}`);
}

async function linkWindowIntoSourceSession(resolved: string, opts: SplitOpts, anchor: string | undefined): Promise<void> {
  const destinationSession = await readAnchorSession(anchor);
  if (!destinationSession) {
    throw new Error("link-window policy requires an anchor pane with a tmux session");
  }
  await runWithOptionalLock(opts, () =>
    hostExec(`tmux link-window -d -s ${shellArg(resolved)} -t ${shellArg(`${destinationSession}:`)}`),
  );
  await refreshSourceClient(anchor);
  console.log(`  \x1b[32m✓\x1b[0m linked background tab — ${resolved}`);
}
