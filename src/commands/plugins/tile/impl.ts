import {
  nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
  applyTiledLayout,
} from "../tmux/layout-manager";
import { hostExec } from "../../../sdk";
import { withPaneLock } from "../../../core/transport/tmux-pane-lock";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function envExport(assignments: Record<string, string>): string {
  return Object.entries(assignments)
    .map(([key, value]) => `${key}=${shellArg(value)}`)
    .join(" ");
}

async function getParentAddress(anchor: string): Promise<string> {
  if (!anchor) return "";
  try {
    return (await hostExec(
      `tmux display-message -t '${anchor}' -p '#{session_name}:#{window_index}.#{pane_index}'`,
    )).trim();
  } catch {
    return anchor;
  }
}

async function getWindowAddress(anchor: string, window: string): Promise<string> {
  if (!anchor) return window;
  try {
    return (await hostExec(
      `tmux display-message -t '${anchor}' -p '#{session_name}:#{window_index}'`,
    )).trim();
  } catch {
    return window;
  }
}

async function listPanes(window: string, format = "#{pane_id}"): Promise<string[]> {
  const raw = await hostExec(`tmux list-panes -t '${window}' -F '${format}'`);
  return raw.split("\n").filter(Boolean);
}

async function countExistingTilePanes(window: string): Promise<number> {
  try {
    const panes = await listPanes(window, "#{pane_id}|||#{pane_title}|||#{@maw_tile}");
    return panes.filter(line => {
      const [, title = "", marker = ""] = line.split("|||");
      return marker === "1" || /^tile-\d+(?: 🌳)?$/.test(title);
    }).length;
  } catch {
    return 0;
  }
}

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
  const parentAddress = await getParentAddress(anchor);
  const windowAddress = await getWindowAddress(anchor, window);
  const existingTileCount = await countExistingTilePanes(window);
  const finalTileTotal = existingTileCount + count;

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
    const tileIndex = existingTileCount + i + 1;
    const name = `tile-${tileIndex}`;

    let cwd = "";
    if (opts.wt) {
      const { createWorktree } = await import("../../shared/wake-session");
      const oracle = repoName.replace(/-oracle$/, "");
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, existingWorktrees);
      cwd = result.wtPath;
      existingWorktrees.push({ name, path: cwd });
    }

    const tileEnv = envExport({
      MAW_TILE_PARENT: parentAddress,
      MAW_TILE_ROLE: name,
      MAW_TILE_INDEX: String(tileIndex),
      MAW_TILE_TOTAL: String(finalTileTotal),
      MAW_TILE_WINDOW: windowAddress,
    });

    let shellCmd = `export ${tileEnv}; exec zsh`;
    if (engineCmd) {
      shellCmd = `export ${tileEnv}; ${engineCmd}; exec zsh`;
    }
    if (cwd) {
      shellCmd = `cd ${shellArg(cwd)} && ${shellCmd}`;
    }

    // Chain: split from last pane so idx order = spawn order
    const splitFrom = paneIds.length > 0 ? paneIds[paneIds.length - 1] : anchor;
    const targetFlag = splitFrom ? `-t '${splitFrom}' ` : "";
    let paneId = "";
    await withPaneLock(async () => {
      paneId = (await hostExec(
        `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' ${shellArg(shellCmd)}`,
      )).trim();
      await new Promise(r => setTimeout(r, 200));
    });

    paneIds.push(paneId);

    const color = nextAgentColor(i);
    const label = opts.wt ? `${name} 🌳` : name;
    await stylePaneBorder(paneId, label, color);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile '1'`);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile_parent ${shellArg(parentAddress)}`);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile_role ${shellArg(name)}`);

    const extras = [
      opts.wt ? `\x1b[90m${cwd}\x1b[0m` : "",
      opts.engine ? `\x1b[90m${opts.engine}\x1b[0m` : "",
    ].filter(Boolean).join(" ");

    console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${label} → ${paneId}${extras ? "  " + extras : ""}`);
  }

  const totalPanes = (await listPanes(window)).length;

  // Layout by total panes after spawn: lead+1 = side-by-side, lead+2-3 =
  // lead full-left with tiles stacked right, 5+ panes = even grid.
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
    `tmux list-panes -t '${window}' -F '#{pane_id}|||#{pane_title}|||#{@maw_tile}'`,
  );
  const lines = raw.split("\n").filter(Boolean);
  let killed = 0;

  for (const line of lines) {
    const [paneId, title = "", marker = ""] = line.split("|||");
    if (paneId === myPane) continue;
    if (marker !== "1" && !/^tile-\d+(?: 🌳)?$/.test(title)) continue;

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

type PaneRow = {
  index: string;
  paneId: string;
  title: string;
  top: number;
};

async function listPaneRows(window: string): Promise<PaneRow[]> {
  const raw = await hostExec(
    `tmux list-panes -t '${window}' -F '#{pane_index}|||#{pane_id}|||#{pane_title}|||#{pane_top}'`,
  );
  return raw.split("\n").filter(Boolean).map((line) => {
    const [index = "", paneId = "", title = "", topRaw = "0"] = line.split("|||");
    return { index, paneId, title, top: parseInt(topRaw, 10) || 0 };
  }).filter(row => row.paneId);
}

function resolveSwapPane(spec: string, rows: PaneRow[]): PaneRow | null {
  const normalized = spec.trim();
  if (!normalized) return null;

  if (normalized === "top") {
    return [...rows].sort((a, b) => a.top - b.top || parseInt(a.index, 10) - parseInt(b.index, 10))[0] ?? null;
  }
  if (normalized === "bottom") {
    return [...rows].sort((a, b) => b.top - a.top || parseInt(b.index, 10) - parseInt(a.index, 10))[0] ?? null;
  }
  if (normalized.startsWith("%")) {
    return rows.find(row => row.paneId === normalized) ?? { index: "", paneId: normalized, title: normalized, top: 0 };
  }
  if (/^\d+$/.test(normalized)) {
    return rows.find(row => row.index === normalized) ?? null;
  }
  return rows.find(row => row.title === normalized || row.title.startsWith(normalized)) ?? null;
}

export async function cmdTileSwap(a: string, b: string): Promise<void> {
  const window = await getWindow();
  const rows = await listPaneRows(window);
  const source = resolveSwapPane(a, rows);
  const target = resolveSwapPane(b, rows);

  if (!source) throw new Error(`tile swap: could not resolve pane '${a}'`);
  if (!target) throw new Error(`tile swap: could not resolve pane '${b}'`);
  if (source.paneId === target.paneId) throw new Error("tile swap: source and target are the same pane");

  await hostExec(`tmux swap-pane -s ${shellArg(source.paneId)} -t ${shellArg(target.paneId)}`);
  console.log(`\x1b[32m✓\x1b[0m swapped ${source.title || source.paneId} ↔ ${target.title || target.paneId}`);
}
