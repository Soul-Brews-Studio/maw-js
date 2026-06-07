import {
  nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
  applyTiledLayout,
} from "../tmux/layout-manager";
import { hostExec } from "../../../sdk";
import { withPaneLock } from "../../../core/transport/tmux-pane-lock";
import { worktreePathForLayout, type WorktreeLayout } from "../../../core/fleet/worktree-layout";

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function envExport(assignments: Record<string, string>): string {
  return Object.entries(assignments)
    .map(([key, value]) => `${key}=${shellArg(value)}`)
    .join(" ");
}

function tileCommandSettleMs(): number {
  const raw = process.env.MAW_TILE_CMD_SETTLE_MS;
  if (raw === undefined || raw === "") return 300;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 300;
  return Math.min(parsed, 5_000);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(r => setTimeout(r, ms));
}

async function sendTileCommand(paneId: string, command: string): Promise<void> {
  if (!command) return;
  const settleMs = tileCommandSettleMs();
  await sleep(settleMs);
  try {
    // #1843 — second parallel tile panes can still be in early shell/TUI boot
    // when --cmd is typed. Clear any prompt noise before the literal payload,
    // then delay Enter separately so tmux has time to drain pending input.
    await hostExec(`tmux send-keys -t '${paneId}' C-u`);
  } catch {
    // Best effort only: the literal command send below is the real action.
  }
  await hostExec(`tmux send-keys -t '${paneId}' -l ${shellArg(command)}`);
  await sleep(Math.min(settleMs, 250));
  await hostExec(`tmux send-keys -t '${paneId}' Enter`);
}

const TILE_TITLE_RE = /^(?:[A-Za-z0-9_.-]+-)?tile-\d+(?: 🌳)?$/;
const TILE_WORKTREE_PATH_RE = /(?:\.wt-\d+-(?:[A-Za-z0-9_.-]+-)?tile-\d+|\/agents\/\d+-(?:[A-Za-z0-9_.-]+-)?tile-\d+)$/;
const TILE_BRANCH_RE = /^agents\/\d+-(?:[A-Za-z0-9_.-]+-)?tile-\d+$/;

function tileScope(parentAddress: string): string {
  const parentSession = parentAddress.split(":")[0]?.trim() ?? "";
  return parentSession
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tileRole(parentAddress: string, tileIndex: number): string {
  const scope = tileScope(parentAddress);
  return scope ? `${scope}-tile-${tileIndex}` : `tile-${tileIndex}`;
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
      return marker === "1" || TILE_TITLE_RE.test(title);
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
  wt?: boolean | string;
  path?: string;
  cmd?: string;
  shell?: boolean;
  engine?: string;
  layout?: WorktreeLayout;
}

function expandHome(raw: string): string {
  if (raw === "~") return process.env.HOME || raw;
  if (raw.startsWith("~/")) return `${process.env.HOME || "~"}${raw.slice(1)}`;
  return raw;
}

async function resolveTileCwd(raw?: string, baseDir?: string): Promise<string> {
  if (raw === undefined) return baseDir ?? "";
  if (!raw.trim()) throw new Error("tile: --path cannot be empty");

  const { isAbsolute, resolve } = await import("path");
  const { stat } = await import("fs/promises");
  const expanded = expandHome(raw);
  const cwd = baseDir && !isAbsolute(expanded) ? resolve(baseDir, expanded) : resolve(expanded);
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error(`tile: path does not exist: ${raw}`);
  }
  if (!info.isDirectory()) throw new Error(`tile: path is not a directory: ${raw}`);
  return cwd;
}

function normalizeTileCommand(raw?: string): string {
  if (raw === undefined) return "";
  if (!raw.trim()) throw new Error("tile: --cmd cannot be empty");
  return raw;
}

function namedWorktree(opts: TileOpts): string {
  return typeof opts.wt === "string" ? opts.wt.trim() : "";
}

async function mainRepoPathFromGitTopLevel(repoPath: string): Promise<string> {
  const { isAbsolute, join, dirname } = await import("path");
  try {
    const commonDir = (await hostExec(`git -C ${shellArg(repoPath)} rev-parse --git-common-dir 2>/dev/null`)).trim();
    if (commonDir && commonDir !== ".git") {
      const mainGit = isAbsolute(commonDir) ? commonDir : join(repoPath, commonDir);
      return dirname(mainGit);
    }
  } catch {
    // Treat repoPath as the main repo below.
  }
  return repoPath;
}

export async function cmdTile(count: number, opts: TileOpts = {}): Promise<void> {
  if (count < 0 || !Number.isFinite(count)) {
    throw new Error("tile: count must be a non-negative integer");
  }
  if (count > 10) {
    throw new Error("tile: max 10 panes (got " + count + ")");
  }

  const requestedWt = namedWorktree(opts);
  const requestedCwd = opts.wt ? "" : await resolveTileCwd(opts.path);
  const requestedCmd = normalizeTileCommand(opts.cmd);

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
  let sharedWtPath = "";
  let sharedWtName = "";

  if (opts.wt) {
    const { findWorktrees, sanitizeBranchName } = await import("../../shared/wake-resolve-impl");
    const { dirname, basename } = await import("path");
    repoPath = await mainRepoPathFromGitTopLevel((await hostExec("git rev-parse --show-toplevel")).trim());
    parentDir = dirname(repoPath);
    repoName = basename(repoPath).replace(/\.wt-.*$/, "");
    existingWorktrees = await findWorktrees(parentDir, repoName);

    if (requestedWt) {
      sharedWtName = sanitizeBranchName(requestedWt);
      if (!sharedWtName) throw new Error("tile: --wt requires a worktree name");
      const expectedPath = worktreePathForLayout({ repoPath, parentDir, repoName, wtName: sharedWtName, layout: opts.layout ?? "nested" });
      const legacyExpectedPath = worktreePathForLayout({ repoPath, parentDir, repoName, wtName: sharedWtName, layout: "legacy" });
      const existing = existingWorktrees.find(w => w.name === sharedWtName || w.path === expectedPath || w.path === legacyExpectedPath);
      if (existing) {
        sharedWtPath = existing.path;
        const { reconcileParentClaudeDir } = await import("../../shared/wake-session");
        await reconcileParentClaudeDir(repoPath, sharedWtPath, console.log.bind(console));
      } else {
        const { createWorktree } = await import("../../shared/wake-session");
        const oracle = repoName.replace(/-oracle$/, "");
        const result = await createWorktree(
          repoPath,
          parentDir,
          repoName,
          oracle,
          sharedWtName,
          existingWorktrees,
          { named: true, layout: opts.layout ?? "nested" },
        );
        sharedWtPath = result.wtPath;
        existingWorktrees.push({ name: sharedWtName, path: sharedWtPath });
      }
    }
  }

  // Spawn all panes chained from previous (preserves index order for grid)
  const paneIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const tileIndex = existingTileCount + i + 1;
    const name = tileRole(parentAddress, tileIndex);

    let cwd = requestedCwd;
    if (sharedWtPath) {
      cwd = await resolveTileCwd(opts.path, sharedWtPath);
    } else if (opts.wt) {
      const { createWorktree } = await import("../../shared/wake-session");
      const oracle = repoName.replace(/-oracle$/, "");
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, existingWorktrees, { layout: opts.layout ?? "nested" });
      cwd = await resolveTileCwd(opts.path, result.wtPath);
      existingWorktrees.push({ name, path: result.wtPath });
    }

    const tileEnv = envExport({
      MAW_TILE_PARENT: parentAddress,
      MAW_TILE_ROLE: name,
      MAW_TILE_INDEX: String(tileIndex),
      MAW_TILE_TOTAL: String(finalTileTotal),
      MAW_TILE_WINDOW: windowAddress,
    });

    const launchCmd = requestedCmd || engineCmd;
    let shellCmd = requestedCmd
      ? `export ${tileEnv}; exec zsh -ic ${shellArg(`${requestedCmd}; exec zsh`)}`
      : `export ${tileEnv}; exec zsh`;
    if (cwd) {
      shellCmd = `cd ${shellArg(cwd)} || exit $?; ${shellCmd}`;
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
    const label = sharedWtName ? `${name} 🌳 ${sharedWtName}` : opts.wt ? `${name} 🌳` : name;
    await stylePaneBorder(paneId, label, color);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile '1'`);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile_parent ${shellArg(parentAddress)}`);
    await hostExec(`tmux set-option -p -t '${paneId}' @maw_tile_role ${shellArg(name)}`);
    if (!requestedCmd) await sendTileCommand(paneId, launchCmd);

    const extras = [
      cwd ? `\x1b[90m${cwd}\x1b[0m` : "",
      requestedCmd ? `\x1b[90mcmd\x1b[0m` : "",
      opts.engine && !requestedCmd ? `\x1b[90m${opts.engine}\x1b[0m` : "",
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
    sharedWtName ? `worktree:${sharedWtName}` : opts.wt ? "worktree" : "",
    opts.path ? "path" : "",
    requestedCmd ? "cmd" : "",
    opts.engine && !requestedCmd ? opts.engine : "",
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
    if (marker !== "1" && !TILE_TITLE_RE.test(title)) continue;

    try {
      await hostExec(`tmux kill-pane -t '${paneId}'`);
      console.log(`  \x1b[31m✗\x1b[0m ${title} (${paneId})`);
      killed++;
    } catch { /* already gone */ }
  }

  // Clean up orphaned tile worktrees
  const { existsSync } = await import("fs");
  try {
    const { dirname, basename } = await import("path");
    const repoPath = await mainRepoPathFromGitTopLevel((await hostExec("git rev-parse --show-toplevel")).trim());
    const parentDir = dirname(repoPath);
    const repoName = basename(repoPath).replace(/\.wt-.*$/, "");
    const mainRepo = `${parentDir}/${repoName}`;
    const wtRaw = await hostExec(`git -C ${shellArg(mainRepo)} worktree list --porcelain 2>/dev/null`);
    const tileWts: { path: string; branch?: string }[] = [];
    let current: { path: string; branch?: string } | null = null;
    for (const line of wtRaw.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) tileWts.push(current);
        current = { path: line.replace("worktree ", "") };
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.replace("branch refs/heads/", "").replace("branch ", "");
      }
    }
    if (current) tileWts.push(current);

    for (const wtInfo of tileWts.filter(w => TILE_WORKTREE_PATH_RE.test(w.path))) {
      const wt = wtInfo.path;
      if (!existsSync(wt)) continue;
      try {
        await hostExec(`git -C ${shellArg(mainRepo)} worktree remove ${shellArg(wt)} --force 2>/dev/null`);
        console.log(`  \x1b[31m✗\x1b[0m worktree ${wt}`);
        killed++;
      } catch { /* ok */ }
      const branch = wtInfo.branch;
      if (branch && TILE_BRANCH_RE.test(branch)) {
        try {
          await hostExec(`git -C ${shellArg(mainRepo)} branch -d ${shellArg(branch)} 2>/dev/null`);
          console.log(`  \x1b[31m✗\x1b[0m branch ${branch}`);
          killed++;
        } catch {
          console.log(`  \x1b[33m⚠\x1b[0m kept branch ${branch} (not fully merged)`);
        }
      }
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
