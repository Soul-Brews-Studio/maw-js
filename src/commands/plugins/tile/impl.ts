import {
  nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
  applyTiledLayout,
} from "../tmux/layout-manager";
import { hostExec } from "../../../sdk";
import { withPaneLock } from "../../../core/transport/tmux-pane-lock";

async function getWindow(): Promise<string> {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    return (await hostExec(`tmux display-message -t '${pane}' -p '#{window_id}'`)).trim();
  }
  return (await hostExec("tmux display-message -p '#{window_id}'")).trim();
}

export interface TileOpts {
  wt?: boolean;
  engine?: string;
}

export async function cmdTile(count: number, opts: TileOpts = {}): Promise<void> {
  if (count < 0 || !Number.isFinite(count)) {
    throw new Error("tile: count must be a non-negative integer");
  }
  if (count > 10) {
    throw new Error("tile: max 10 panes (got " + count + ")");
  }

  const window = await getWindow();

  if (count === 0) {
    await applyTiledLayout(window);
    console.log("\x1b[32m✓\x1b[0m tiled");
    return;
  }

  const anchor = process.env.TMUX_PANE ?? "";

  let engineCmd = "";
  if (opts.engine) {
    const { loadConfig } = await import("../../../config");
    const commands = loadConfig().commands || {};
    engineCmd = commands[opts.engine] || opts.engine;
  }

  let repoPath = "";
  let parentDir = "";
  let repoName = "";
  let existingWorktrees: { name: string; path: string }[] = [];

  if (opts.wt) {
    const { findWorktrees } = await import("../../shared/wake-resolve-impl");
    repoPath = (await hostExec("git rev-parse --show-toplevel")).trim();
    const { dirname, basename } = await import("path");
    parentDir = dirname(repoPath);
    repoName = basename(repoPath).replace(/\.wt-.*$/, "");
    const mainRepo = `${parentDir}/${repoName}`;
    try {
      await hostExec(`git -C '${mainRepo}' rev-parse --git-dir 2>/dev/null`);
      repoPath = mainRepo;
    } catch { /* already main */ }
    existingWorktrees = await findWorktrees(parentDir, repoName);
  }

  // Spawn all panes chained from previous (preserves index order for grid)
  const paneIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const name = `tile-${i + 1}`;

    let cwd = "";
    if (opts.wt) {
      const { createWorktree } = await import("../../shared/wake-session");
      const oracle = repoName.replace(/-oracle$/, "");
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, existingWorktrees);
      cwd = result.wtPath;
      existingWorktrees.push({ name, path: cwd });
    }

    let shellCmd = "exec zsh";
    if (engineCmd) {
      shellCmd = `${engineCmd.replace(/'/g, "'\\''")}; exec zsh`;
    }
    if (cwd) {
      shellCmd = `cd '${cwd.replace(/'/g, "'\\''")}' && ${shellCmd}`;
    }

    // Chain: split from last pane so idx order = spawn order
    const splitFrom = paneIds.length > 0 ? paneIds[paneIds.length - 1] : anchor;
    const targetFlag = splitFrom ? `-t '${splitFrom}' ` : "";
    let paneId = "";
    await withPaneLock(async () => {
      paneId = (await hostExec(
        `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' '${shellCmd}'`,
      )).trim();
      await new Promise(r => setTimeout(r, 200));
    });

    paneIds.push(paneId);

    const color = nextAgentColor(i);
    const label = opts.wt ? `${name} 🌳` : name;
    await stylePaneBorder(paneId, label, color);

    const extras = [
      opts.wt ? `\x1b[90m${cwd}\x1b[0m` : "",
      opts.engine ? `\x1b[90m${opts.engine}\x1b[0m` : "",
    ].filter(Boolean).join(" ");

    console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${label} → ${paneId}${extras ? "  " + extras : ""}`);
  }

  // Layout decision uses TOTAL pane count (lead + all tiles), not just new spawns.
  // 2 panes = lead | tile (even split), 3-4 = main-vertical (lead-left, tiles-right),
  // 5+ = tiled grid. (#1394)
  const paneCountRaw = (await hostExec(`tmux list-panes -t '${window}' | wc -l`)).trim();
  const totalPanes = parseInt(paneCountRaw, 10) || (count + 1);
  if (totalPanes === 2) {
    await hostExec(`tmux select-layout -t '${window}' even-horizontal`);
  } else if (totalPanes <= 4) {
    await hostExec(`tmux select-layout -t '${window}' main-vertical`);
  } else {
    await applyTiledLayout(window);
  }
  await enableBorderStatus(window);

  const flags = [
    opts.wt ? "worktree" : "",
    opts.engine || "",
  ].filter(Boolean).join(", ");

  console.log(`\x1b[32m✓\x1b[0m ${count} panes tiled${flags ? " (" + flags + ")" : ""}`);
}

export async function cmdTileClean(): Promise<void> {
  const window = await getWindow();
  const myPane = process.env.TMUX_PANE ?? "";

  const raw = await hostExec(
    `tmux list-panes -t '${window}' -F '#{pane_id} #{pane_title}'`,
  );
  const lines = raw.split("\n").filter(Boolean);
  let killed = 0;

  for (const line of lines) {
    const [paneId, ...titleParts] = line.split(" ");
    const title = titleParts.join(" ");
    if (paneId === myPane) continue;

    try {
      await hostExec(`tmux kill-pane -t '${paneId}'`);
      console.log(`  \x1b[31m✗\x1b[0m ${title} (${paneId})`);
      killed++;
    } catch { /* already gone */ }
  }

  // Clean up orphaned tile worktrees
  const { existsSync } = await import("fs");
  try {
    const repoPath = (await hostExec("git rev-parse --show-toplevel")).trim();
    const { dirname, basename } = await import("path");
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath).replace(/\.wt-.*$/, "");
    const mainRepo = `${parentDir}/${repoName}`;
    const wtRaw = await hostExec(`git -C '${mainRepo}' worktree list --porcelain 2>/dev/null`);
    const tileWts = wtRaw.split("\n")
      .filter(l => l.startsWith("worktree "))
      .map(l => l.replace("worktree ", ""))
      .filter(p => /\.wt-\d+-tile-\d+$/.test(p));

    for (const wt of tileWts) {
      if (!existsSync(wt)) continue;
      try {
        await hostExec(`git -C '${mainRepo}' worktree remove '${wt}' --force 2>/dev/null`);
        console.log(`  \x1b[31m✗\x1b[0m worktree ${wt}`);
        killed++;
      } catch { /* ok */ }
    }
  } catch { /* not in a git repo */ }

  if (killed === 0) {
    console.log("\x1b[90mno tile panes or worktrees to clean\x1b[0m");
  } else {
    console.log(`\x1b[32m✓\x1b[0m cleaned ${killed} tiles`);
  }
}
