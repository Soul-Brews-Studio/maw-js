import { hostExec } from "../../sdk";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

export async function maybeSplit(target: string, opts: { split?: boolean }): Promise<void> {
  if (!opts.split) return;
  if (process.env.TMUX) {
    try {
      const anchor = process.env.TMUX_PANE;
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
  const session = target.split(":")[0] || target;
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

async function openBackgroundTab(target: string): Promise<void> {
  const session = target.split(":")[0] || target;
  const targetWindow = target.split(":").slice(1).join(":") || session;
  const windowName = `bring-${targetWindow}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "bring";
  const innerCmd = `TMUX= tmux attach-session -t ${shellArg(target)}`;
  await hostExec(`tmux new-window -d -n ${shellArg(windowName)} ${shellArg(innerCmd)}`);
  console.log(`  \x1b[32m✓\x1b[0m opened background tab — ${target}`);
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
