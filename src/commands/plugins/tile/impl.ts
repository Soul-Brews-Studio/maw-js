import {
  nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
  applyTiledLayout, getWindowTarget,
} from "../tmux/layout-manager";
import { hostExec } from "../../../sdk";
import { withPaneLock } from "../../../core/transport/tmux-pane-lock";

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

  const window = await getWindowTarget();

  if (count === 0) {
    await applyTiledLayout(window);
    console.log("\x1b[32m✓\x1b[0m tiled");
    return;
  }

  const anchor = process.env.TMUX_PANE ?? "";

  // Resolve engine command if specified
  let engineCmd = "";
  if (opts.engine) {
    const { loadConfig } = await import("../../../config");
    const commands = loadConfig().commands || {};
    engineCmd = commands[opts.engine] || opts.engine;
  }

  // Resolve repo info for worktree mode
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
    // Use the main repo for worktree creation (not a worktree of a worktree)
    const mainRepo = `${parentDir}/${repoName}`;
    try {
      await hostExec(`git -C '${mainRepo}' rev-parse --git-dir 2>/dev/null`);
      repoPath = mainRepo;
    } catch { /* already main */ }
    existingWorktrees = await findWorktrees(parentDir, repoName);
  }

  for (let i = 0; i < count; i++) {
    const name = `tile-${i + 1}`;
    const color = nextAgentColor(i);
    const targetFlag = anchor ? `-t '${anchor}' ` : "";

    let cwd = "";

    if (opts.wt) {
      const { createWorktree } = await import("../../shared/wake-session");
      const oracle = repoName.replace(/-oracle$/, "");
      const result = await createWorktree(repoPath, parentDir, repoName, oracle, name, existingWorktrees);
      cwd = result.wtPath;
      existingWorktrees.push({ name, path: cwd });
    }

    // Build shell command
    let shellCmd = "exec zsh";
    if (engineCmd) {
      shellCmd = `${engineCmd.replace(/'/g, "'\\''")}; exec zsh`;
    }

    // Add cwd change for worktree panes
    if (cwd) {
      shellCmd = `cd '${cwd.replace(/'/g, "'\\''")}' && ${shellCmd}`;
    }

    let paneId = "";
    await withPaneLock(async () => {
      paneId = (await hostExec(
        `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' '${shellCmd}'`,
      )).trim();
      await new Promise(r => setTimeout(r, 200));
    });

    const label = opts.wt ? `${name} 🌳` : name;
    await stylePaneBorder(paneId, label, color);
    await applyTiledLayout(window);
    await enableBorderStatus(window);

    const extras = [
      opts.wt ? `\x1b[90m${cwd}\x1b[0m` : "",
      opts.engine ? `\x1b[90m${opts.engine}\x1b[0m` : "",
    ].filter(Boolean).join(" ");

    console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${label} → ${paneId}${extras ? "  " + extras : ""}`);
  }

  const flags = [
    opts.wt ? "worktree" : "",
    opts.engine || "",
  ].filter(Boolean).join(", ");

  console.log(`\x1b[32m✓\x1b[0m ${count} panes tiled${flags ? " (" + flags + ")" : ""}`);
}
