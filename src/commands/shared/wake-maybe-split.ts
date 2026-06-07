import { hostExec } from "../../sdk";
import { isClaudeLikePane } from "../plugins/tmux/safety";
import { isSelfBring } from "./bring-flags";

/**
 * #1816 — read the caller's pane address as "session:window" from tmux.
 * Returns null when not in tmux or the lookup fails (we proceed without
 * the self-bring check — fail open, since the existing behavior was no
 * check at all).
 */
async function readCallerSessionWindow(anchor: string | undefined): Promise<string | null> {
  if (!anchor) return null;
  try {
    const raw = await hostExec(
      `tmux display-message -p -t ${shellArg(anchor)} '#{session_name}:#{window_name}'`,
    );
    const out = String(raw).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function backgroundAttachCommand(target: string): string {
  // Detached background tabs run a nested tmux client inside a fresh pane.
  // Clear/reset that pane before attach so stale redraw artifacts from the
  // caller are not mirrored into the new tab (#1816 live smear at cccbd33c).
  return `unset TMUX; printf '\\033c'; clear 2>/dev/null || true; exec tmux attach-session -t ${shellArg(target)}`;
}

/** @internal — exported for tests only. */
export async function probeTmuxServer(): Promise<boolean> {
  try {
    await hostExec("tmux display-message -p '#S'");
    return true;
  } catch {
    return false;
  }
}


async function restoreSplitLayout(anchor?: string): Promise<void> {
  try {
    const windowTarget = anchor || process.env.TMUX_PANE;
    const targetFlag = windowTarget ? `-t ${shellArg(windowTarget)} ` : "";
    const raw = await hostExec(`tmux list-panes ${targetFlag}| wc -l`);
    const total = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(total) || total <= 2) return;
    const layout = total > 4 ? "tiled" : "main-vertical";
    await hostExec(`tmux select-layout ${targetFlag}${layout}`);
  } catch {
    // Best-effort polish only: split succeeded, so never fail delivery because
    // the caller's tmux cannot reflow the current window.
  }
}

async function refreshSplitClient(): Promise<void> {
  try {
    await hostExec("tmux refresh-client -S");
  } catch {
    // Best-effort redraw nudge only (#1562): if tmux rejects refresh-client
    // in a headless or old-server environment, keep the successful split.
  }
}

async function bestEffortTmux(command: string): Promise<void> {
  try {
    await hostExec(command);
  } catch {
    // Best-effort repaint only: the user action already succeeded.
  }
}

async function refreshSourceClient(anchor?: string): Promise<void> {
  if (anchor) {
    try {
      const raw = await hostExec(`tmux display-message -p -t ${shellArg(anchor)} '#{client_name}|#{client_tty}'`);
      const clients = String(raw)
        .split("|")
        .map(client => client.trim())
        .filter((client, index, all) => client.length > 0 && all.indexOf(client) === index);
      for (const client of clients) {
        // Force a real repaint of the source client, then update status.
        // `refresh-client -c` only resets cursor tracking; it does not repaint
        // the visible body, which let the lower-half dot smear persist at
        // 957c41c1. A no-flag targeted refresh is the tmux body redraw.
        await bestEffortTmux(`tmux refresh-client -t ${shellArg(client)}`);
        await bestEffortTmux(`tmux refresh-client -S -t ${shellArg(client)}`);
      }
    } catch {
      // Fall through to global redraws. Some tmux versions or transient clients
      // reject targeted refreshes even though the repaint is only cosmetic.
    }
  }

  // Always also repaint the current/default client. Earlier builds returned
  // after a targeted refresh even when tmux rejected the client target inside
  // bestEffortTmux, leaving Nat's live Claude pane with the lower-half smear.
  await bestEffortTmux("tmux refresh-client");
  await bestEffortTmux("tmux refresh-client -S");
}

async function repaintSourcePane(anchor?: string): Promise<void> {
  if (!anchor) return;
  try {
    await hostExec(`tmux send-keys -R -t ${shellArg(anchor)} C-l`);
    await bestEffortTmux(`tmux clear-history -t ${shellArg(anchor)}`);
  } catch {
    // Keep going: the full-client refresh below is often the more
    // important part of clearing stale lower-half redraw artifacts.
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

async function isClaudeLikeCallerPane(anchor?: string): Promise<boolean> {
  if (!anchor) return false;
  if (process.env.MAW_ALLOW_CLAUDE_SPLIT === "1") return false;
  try {
    const raw = await hostExec(`tmux display-message -p -t ${shellArg(anchor)} '#{pane_current_command}'`);
    return isClaudeLikePane(String(raw).trim());
  } catch {
    return false;
  }
}

async function isMawTilePane(anchor?: string): Promise<boolean> {
  if (!anchor) return false;
  try {
    const raw = await hostExec(`tmux show-options -p -t ${shellArg(anchor)} -v @maw_tile 2>/dev/null || true`);
    return String(raw).trim() === "1";
  } catch {
    return false;
  }
}

type PaneGeometry = {
  id: string;
  top: number;
  left: number;
  isTile: boolean;
};

function parsePaneGeometry(raw: string): PaneGeometry[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [id, top, left, tile] = line.split("|");
      return {
        id: id || "",
        top: Number.parseInt(top || "", 10),
        left: Number.parseInt(left || "", 10),
        isTile: tile === "1",
      };
    })
    .filter(p => p.id && Number.isFinite(p.top) && Number.isFinite(p.left));
}

/** @internal — exported for tests only. */
export async function findTopRightPane(anchor?: string): Promise<string | null> {
  if (!anchor) return null;
  const targetFlag = `-t ${shellArg(anchor)} `;
  const raw = await hostExec(`tmux list-panes ${targetFlag}-F '#{pane_id}|#{pane_top}|#{pane_left}|#{@maw_tile}'`);
  const panes = parsePaneGeometry(String(raw)).filter(p => p.id !== anchor);
  if (panes.length === 0) return null;

  const tilePanes = panes.filter(p => p.isTile);
  const candidates = tilePanes.length > 0 ? tilePanes : panes;
  candidates.sort((a, b) => a.top - b.top || b.left - a.left || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

function targetSession(target: string): string {
  return target.split(":")[0] || target;
}

function targetWindow(target: string): string | null {
  const window = target.split(":").slice(1).join(":").trim();
  return window.length > 0 ? window : null;
}

function sameSessionExistingWindow(target: string, sourceSession: string | undefined): boolean {
  return Boolean(sourceSession) && targetSession(target) === sourceSession && targetWindow(target) !== null;
}

function sameSessionTarget(target: string, callerSessionWindow: string | null): boolean {
  return Boolean(callerSessionWindow) && targetSession(target) === targetSession(callerSessionWindow || "");
}

export async function maybeSplit(target: string, opts: { split?: boolean; splitTarget?: string }): Promise<void> {
  if (!opts.split) return;
  if (process.env.TMUX || opts.splitTarget) {
    try {
      const anchor = opts.splitTarget || process.env.TMUX_PANE;
      const callerSW = await readCallerSessionWindow(anchor);
      // #1816 — refuse to split-bring an oracle into its own pane. A child
      // pane that attach-sessions back to its own parent session creates
      // nested-attach + amplifies the #1562 redraw smear into a persistent
      // loop. MAW_ALLOW_SELF_BRING=1 overrides for diagnostic use.
      if (process.env.MAW_ALLOW_SELF_BRING !== "1") {
        if (isSelfBring(target, callerSW)) {
          console.log(`  \x1b[31m✗\x1b[0m refusing to split-bring oracle into its own pane (#1816 — would loop).`);
          console.log(`      \x1b[90mtarget:           ${target}\x1b[0m`);
          console.log(`      \x1b[90mcaller pane:      ${callerSW}\x1b[0m`);
          console.log(`      \x1b[90mto override:      MAW_ALLOW_SELF_BRING=1 maw bring ...\x1b[0m`);
          return;
        }
      }
      if (await isClaudeLikeCallerPane(anchor) && process.env.MAW_SAFE_SPLIT === "1") {
        const action = await openBackgroundTab(target, {
          destinationSession: opts.splitTarget ? targetSession(opts.splitTarget) : undefined,
          sourceAnchor: anchor,
          sourceSession: callerSW ? targetSession(callerSW) : undefined,
          preferLinkWindow: true,
        });
        const label = action === "existing" ? "target already in background tab" :
          action === "linked" ? "linked as background tab" :
            "opened as background tab";
        console.log(`  \x1b[36m→\x1b[0m ${label} (MAW_SAFE_SPLIT=1 — explicit smear-avoidance opt-in).`);
        return;
      }
      if (
        sameSessionTarget(target, callerSW) &&
        !(process.env.MAW_ALLOW_SELF_BRING === "1" && callerSW && isSelfBring(target, callerSW))
      ) {
        console.log(`  \x1b[31m✗\x1b[0m same-session --split unsupported — nested attach would close the pane (#1835).`);
        console.log(`      \x1b[90mtarget:           ${target}\x1b[0m`);
        console.log(`      \x1b[90mcaller pane:      ${callerSW}\x1b[0m`);
        console.log(`      \x1b[90muse instead:      tmux switch-client -t ${target}\x1b[0m`);
        return;
      }
      const targetFlag = anchor ? `-t ${shellArg(anchor)} ` : "";
      const innerCmd = `TMUX= tmux attach-session -t ${shellArg(target)}`;
      await hostExec(`tmux split-window ${targetFlag}-h -l 50% ${shellArg(innerCmd)}`);
      if (!(await isMawTilePane(anchor))) {
        await restoreSplitLayout(anchor);
      }
      await refreshSplitClient();
      console.log(`  \x1b[32m✓\x1b[0m split beside — ${target} (50%)`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  \x1b[33m⚠\x1b[0m split failed: ${message}`);
    }
    return;
  }
  const serverUp = await probeTmuxServer();
  const session = targetSession(target);
  if (serverUp) {
    console.log(`  \x1b[33m⚠\x1b[0m --split skipped — shell is not attached to a tmux pane.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto view:          tmux attach -t ${session}\x1b[0m`);
    console.log(`      \x1b[90mto silence:       drop --split when running headless\x1b[0m`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m --split skipped — tmux server not running.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto start tmux:    tmux new -s work\x1b[0m`);
    console.log(`      \x1b[90mto silence:       drop --split when running headless\x1b[0m`);
  }
}

type BackgroundTabOptions = {
  destinationSession?: string;
  sourceAnchor?: string;
  sourceSession?: string;
  preferLinkWindow?: boolean;
};

async function openBackgroundTab(target: string, opts: BackgroundTabOptions = {}): Promise<"opened" | "linked" | "existing"> {
  const session = targetSession(target);
  const targetWindow = target.split(":").slice(1).join(":") || session;
  const windowName = `bring-${targetWindow}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "bring";
  const innerCmd = backgroundAttachCommand(target);
  const destinationSession = opts.destinationSession || opts.sourceSession;
  if (opts.preferLinkWindow && destinationSession) {
    if (sameSessionExistingWindow(target, destinationSession)) {
      await repaintSourcePane(opts.sourceAnchor);
      console.log(`  \x1b[32m✓\x1b[0m target tab already in this session — ${target}`);
      return "existing";
    }
    try {
      await repaintSourcePane(opts.sourceAnchor);
      await hostExec(`tmux link-window -d -s ${shellArg(target)} -t ${shellArg(`${destinationSession}:`)}`);
      await repaintSourcePane(opts.sourceAnchor);
      console.log(`  \x1b[32m✓\x1b[0m linked background tab — ${target}`);
      return "linked";
    } catch {
      // Fall back to a detached attach tab only when link-window is unavailable
      // (for example older tmux, an un-linkable target, or permissions). The
      // same-session existing-window case above never falls through because a
      // duplicate nested attach is the exact lower-half smear Nat reproduced at
      // 957c41c1.
    }
  }
  const destination = opts.destinationSession ? `-t ${shellArg(`${opts.destinationSession}:`)} ` : "";
  await repaintSourcePane(opts.sourceAnchor);
  const opened = await hostExec(`tmux new-window -P -F '#{window_id}' -d ${destination}-n ${shellArg(windowName)} ${shellArg(innerCmd)}`);
  const openedWindow = String(opened).trim();
  if (openedWindow.length > 0) await clearNewTabPane(openedWindow);
  if (opts.sourceAnchor) {
    // The detached nested attach can make tmux repaint the caller after our
    // first C-l. Repaint again, then structurally refresh the *client attached
    // to that pane* (not merely the global status line) so Claude-like TUIs do
    // not keep the lower-half dot smear observed at 957c41c1.
    await repaintSourcePane(opts.sourceAnchor);
  }
  console.log(`  \x1b[32m✓\x1b[0m opened background tab — ${target}`);
  return "opened";
}

export async function maybeOpenWindow(target: string, opts: { bring?: boolean; tab?: boolean }): Promise<void> {
  if (!opts.bring) return;
  const session = target.split(":")[0] || target;
  if (process.env.TMUX) {
    try {
      const innerCmd = `TMUX= tmux attach-session -t ${shellArg(target)}`;
      const replacementPane = opts.tab ? null : await findTopRightPane(process.env.TMUX_PANE);
      if (replacementPane) {
        await hostExec(`tmux respawn-pane -k -t ${shellArg(replacementPane)} ${shellArg(innerCmd)}`);
        console.log(`  \x1b[32m✓\x1b[0m replaced top-right pane — ${target}`);
      } else {
        await openBackgroundTab(target);
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  \x1b[33m⚠\x1b[0m bring failed: ${message}`);
    }
    return;
  }
  const serverUp = await probeTmuxServer();
  if (serverUp) {
    console.log(`  \x1b[33m⚠\x1b[0m bring skipped — shell is not attached to a tmux pane.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto view:          tmux attach -t ${session}\x1b[0m`);
    console.log(`      \x1b[90mto silence:       use maw wake instead of maw bring when running headless\x1b[0m`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m bring skipped — tmux server not running.`);
    console.log(`      \x1b[90mstate created:    ${target}\x1b[0m`);
    console.log(`      \x1b[90mto start tmux:    tmux new -s work\x1b[0m`);
    console.log(`      \x1b[90mto silence:       use maw wake instead of maw bring when running headless\x1b[0m`);
  }
}
