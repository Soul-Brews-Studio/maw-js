import { hostExec, tmux } from "../../sdk";
import { buildCommand, buildCommandInDir, cfgTimeout } from "../../config";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { normalizeWorktreeLayout, worktreePathForLayout, type WorktreeLayout } from "../../core/fleet/worktree-layout";

type WakeTmuxDeps = Pick<typeof tmux, "switchClient" | "listWindows" | "getPaneCommands" | "sendText">;

export interface WakeSessionDeps {
  hostExec: typeof hostExec;
  tmux: WakeTmuxDeps;
  buildCommand: typeof buildCommand;
  buildCommandInDir: typeof buildCommandInDir;
  cfgTimeout: typeof cfgTimeout;
  execSync: typeof execSync;
  sleep: (ms: number) => Promise<void>;
  log: (...args: unknown[]) => void;
  /** Force a new numbered worktree slot instead of preferring a stable reusable slot. */
  fresh: boolean;
  /** Use an exact stable worktree/branch name instead of a numbered slot (#1768 --name). */
  named: boolean;
  /** Filesystem layout for newly-created worktrees (#1850). Defaults to nested repo/agents/<name>. */
  layout: WorktreeLayout;
  /** Existing tmux window names in the target session; used to avoid duplicate wake --task windows. */
  existingWindowNames: Iterable<string>;
  /** Engine to persist for rehydrating this worktree later. Defaults to claude. */
  engine: string;
}

export function wakeSessionDeps(overrides: Partial<WakeSessionDeps> = {}): WakeSessionDeps {
  return {
    hostExec,
    tmux,
    buildCommand,
    buildCommandInDir,
    cfgTimeout,
    execSync,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: console.log.bind(console),
    fresh: false,
    named: false,
    layout: "nested",
    existingWindowNames: [],
    engine: "claude",
    ...overrides,
  };
}

export const WORKTREE_ENGINE_FILE = ".maw-engine";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function acquireWorktreePathLock(
  wtPath: string,
  hostExecFn: WakeSessionDeps["hostExec"],
): Promise<(() => Promise<void>) | null> {
  const quotedPath = shellSingleQuote(wtPath);
  const quotedLock = shellSingleQuote(`${wtPath}.maw-create.lock`);
  try {
    await hostExecFn(`[ ! -e ${quotedPath} ] && mkdir ${quotedLock}`);
  } catch {
    return null;
  }
  return async () => {
    try {
      await hostExecFn(`rmdir ${quotedLock} 2>/dev/null || true`);
    } catch { /* best-effort lock cleanup */ }
  };
}

function normalizeWorktreeEngineName(engine: string | undefined, fallbackToClaude = false): string | undefined {
  const normalized = ((engine ?? (fallbackToClaude ? "claude" : ""))).trim().split(/\r?\n/, 1)[0]?.trim();
  if (!normalized) return undefined;
  // Engine names are config keys / built-ins. Ignore unsafe file contents rather
  // than letting a compromised worktree marker become a shell command.
  if (!/^[A-Za-z0-9_.:-]+$/.test(normalized)) return undefined;
  return normalized;
}

export function readWorktreeEngineFile(wtPath: string): string | undefined {
  try {
    return normalizeWorktreeEngineName(readFileSync(join(wtPath, WORKTREE_ENGINE_FILE), "utf-8"));
  } catch {
    return undefined;
  }
}

export function writeWorktreeEngineFile(
  wtPath: string,
  engine: string | undefined,
  log: WakeSessionDeps["log"] = () => {},
): void {
  const normalized = normalizeWorktreeEngineName(engine, true);
  if (!normalized) return;
  try {
    writeFileSync(join(wtPath, WORKTREE_ENGINE_FILE), `${normalized}\n`, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`\x1b[33m⚠\x1b[0m .maw-engine write skipped: ${message}`);
  }
}

/** Attach to tmux session — switch-client if inside tmux, attach if fresh shell */
export async function attachToSession(session: string, deps: Partial<WakeSessionDeps> = {}) {
  const d = wakeSessionDeps(deps);
  if (process.env.TMUX) {
    await d.tmux.switchClient(session);
  } else {
    d.execSync(`tmux attach-session -t ${session}`, { stdio: "inherit" });
  }
}

/**
 * Check whether a tmux pane's shell is idle (no child processes).
 * Returns true when the shell has no children → safe to retry.
 * Returns true on error as a fail-safe (preserves existing retry behavior).
 */
export async function isPaneIdle(paneTarget: string, deps: Partial<WakeSessionDeps> = {}): Promise<boolean> {
  const d = wakeSessionDeps(deps);
  try {
    const panePid = (await d.hostExec(
      `tmux display-message -t '${paneTarget}' -p '#{pane_pid}'`
    )).trim();
    if (!panePid) return true;
    // pgrep -P shows direct children — if any, the shell is busy
    const children = (await d.hostExec(`pgrep -P ${panePid} 2>/dev/null || true`)).trim();
    return children.length === 0;
  } catch {
    return true; // fail-safe to current behavior
  }
}

/**
 * Poll until the pane's command is recognised as an agent binary, or timeout.
 *
 * Fixes the new-session race (#1906): after sendText() launches a non-claude
 * engine (e.g. thclaws --cli), the tmux pane command may still report 'zsh'
 * for several hundred ms before the shell execs the engine. Without this wait,
 * the liveness check that follows immediately can see 'zsh', decide the agent
 * is dead, and issue a second sendText() — which lands in the already-running
 * engine's chat instead of the shell.
 *
 * @returns true when the engine is confirmed, false on timeout (5 s default).
 */
export async function waitForEngine(
  paneTarget: string,
  getPaneInfos: (targets: string[]) => Promise<Record<string, { command: string }>>,
  isAgentCommand: (cmd: string | null | undefined) => boolean,
  timeoutMs?: number,
  pollIntervalMs = 250,
): Promise<boolean> {
  // Env-gated override so tests can short-circuit the poll budget.
  // MAW_AGENT_BOOT_POLL_MS=0 → skip the poll entirely (return false immediately).
  const envBudget = process.env.MAW_AGENT_BOOT_POLL_MS;
  const effectiveTimeout = envBudget !== undefined ? Number(envBudget) : (timeoutMs ?? 5000);
  if (effectiveTimeout <= 0) return false;
  const deadline = Date.now() + effectiveTimeout;
  while (Date.now() < deadline) {
    try {
      const infos = await getPaneInfos([paneTarget]);
      const info = infos[paneTarget];
      if (info && isAgentCommand(info.command)) return true;
    } catch { /* tolerate transient tmux errors during engine startup */ }
    if (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
  }
  return false;
}

export async function reconcileParentClaudeDir(repoPath: string, wtPath: string, log: WakeSessionDeps["log"]): Promise<void> {
  const { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } = await import("fs");
  const { symlink } = await import("fs/promises");
  const { join, relative } = await import("path");
  const parentClaudeDir = join(repoPath, ".claude");
  const parentSkillsDir = join(parentClaudeDir, "skills");
  const wtClaudeLink = join(wtPath, ".claude");
  if (!existsSync(parentClaudeDir)) return;

  if (!existsSync(wtClaudeLink)) {
    const target = relative(wtPath, parentClaudeDir) || parentClaudeDir;
    try {
      await symlink(target, wtClaudeLink, "dir");
      log(`\x1b[32m+\x1b[0m .claude: ${wtClaudeLink} → ${target}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`\x1b[33m⚠\x1b[0m .claude share skipped: ${message}`);
    }
    return;
  }

  if (!existsSync(parentSkillsDir)) return;
  try {
    if (lstatSync(wtClaudeLink).isSymbolicLink()) return;
  } catch { return; }

  const wtSkillsLink = join(wtClaudeLink, "skills");
  if (existsSync(wtSkillsLink)) {
    let replace = false;
    try {
      const stat = lstatSync(wtSkillsLink);
      if (stat.isSymbolicLink()) return;
      if (!stat.isDirectory()) {
        log(`\x1b[33m⚠\x1b[0m .claude/skills share skipped: existing non-directory`);
        return;
      }
      const entries = readdirSync(wtSkillsLink);
      replace = entries.length === 0 || entries.every(name => existsSync(join(parentSkillsDir, name)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`\x1b[33m⚠\x1b[0m .claude/skills share skipped: ${message}`);
      return;
    }
    if (!replace) {
      log(`\x1b[33m⚠\x1b[0m .claude/skills share skipped: local-only skills present`);
      return;
    }
    rmSync(wtSkillsLink, { recursive: true, force: true });
  } else {
    mkdirSync(wtClaudeLink, { recursive: true });
  }

  const target = relative(wtClaudeLink, parentSkillsDir) || parentSkillsDir;
  try {
    await symlink(target, wtSkillsLink, "dir");
    log(`\x1b[32m+\x1b[0m .claude/skills: ${wtSkillsLink} → ${target}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`\x1b[33m⚠\x1b[0m .claude/skills share skipped: ${message}`);
  }
}

export async function ensureSessionRunning(
  session: string,
  excludeNames?: Set<string>,
  cwdMap?: Record<string, string>,
  deps: Partial<WakeSessionDeps> = {},
): Promise<number> {
  const d = wakeSessionDeps(deps);
  let retried = 0;
  let windows: { index: number; name: string; active: boolean }[];
  try { windows = await d.tmux.listWindows(session); } catch { return 0; }

  const targets = windows.map(w => `${session}:${w.name}`);
  const cmds = await d.tmux.getPaneCommands(targets);

  for (const win of windows) {
    if (excludeNames?.has(win.name)) continue;
    const target = `${session}:${win.name}`;
    const paneCmd = (cmds[target] || "").trim().toLowerCase();
    if (paneCmd === "zsh" || paneCmd === "bash" || paneCmd === "sh" || paneCmd === "") {
      if (!(await isPaneIdle(target, d))) continue; // shell has children → mid-startup, skip
      try {
        await d.sleep(d.cfgTimeout("wakeRetry"));
        const cwd = cwdMap?.[win.name];
        const cmd = cwd ? d.buildCommandInDir(win.name, cwd) : d.buildCommand(win.name);
        await d.tmux.sendText(target, cmd);
        d.log(`\x1b[33m↻\x1b[0m retry: ${win.name} (was ${paneCmd || "empty"})`);
        retried++;
      } catch { /* window may have been killed */ }
    }
  }
  return retried;
}

/**
 * Create a new git worktree for an oracle task.
 * Returns the worktree path and window name.
 */
export async function createWorktree(
  repoPath: string,
  parentDir: string,
  repoName: string,
  oracle: string,
  name: string,
  existingWorktrees: { name: string; path: string }[],
  deps: Partial<WakeSessionDeps> = {},
): Promise<{ wtPath: string; windowName: string }> {
  const d = wakeSessionDeps(deps);
  const nums = existingWorktrees.map(w => parseInt(w.name) || 0);
  let nextNum = d.fresh && nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const safe = (s: string) => s.replace(/'/g, "'\\''");
  try { await d.hostExec(`git -C ${shellSingleQuote(repoPath)} rev-parse HEAD 2>/dev/null`); } catch {
    await d.hostExec(`git -C ${shellSingleQuote(repoPath)} commit --allow-empty -m "init: bootstrap for worktree"`);
  }

  const layout = normalizeWorktreeLayout(d.layout);
  if (layout === "nested") {
    await d.hostExec(`mkdir -p ${shellSingleQuote(`${repoPath}/agents`)}`);
  }
  const existingWindowNames = new Set([...d.existingWindowNames].filter(Boolean));
  const preferredWindowName = `${oracle}-${name}`;
  const windowNameForWorktree = (wtName: string): string => {
    if (d.named) return preferredWindowName;
    return existingWindowNames.has(preferredWindowName) ? `${oracle}-${wtName}` : preferredWindowName;
  };
  let wtName = "";
  let wtPath = "";
  let branch = "";
  let windowName = "";
  let branchExists = false;
  let allocated = false;
  let releaseWorktreePathLock: (() => Promise<void>) | null = null;
  if (d.named) {
    wtName = name;
    wtPath = worktreePathForLayout({ repoPath, parentDir, repoName, wtName, layout });
    branch = `agents/${wtName}`;
    windowName = windowNameForWorktree(wtName);
    if (existingWindowNames.has(windowName)) {
      throw new Error(`tmux window '${windowName}' already exists`);
    }
    const knownWorktree = existingWorktrees.some(w => w.name === wtName || w.path === wtPath);
    if (!knownWorktree) {
      releaseWorktreePathLock = await acquireWorktreePathLock(wtPath, d.hostExec);
      if (!releaseWorktreePathLock) throw new Error(`worktree slot '${wtName}' is already reserved`);
      try {
        await d.hostExec(`git -C '${safe(repoPath)}' show-ref --verify --quiet 'refs/heads/${safe(branch)}'`);
        branchExists = true;
      } catch {
        branchExists = false;
      }
      allocated = true;
    }
  } else {
    for (let attempts = 0; attempts < 1000; attempts++) {
      wtName = `${nextNum}-${name}`;
      wtPath = worktreePathForLayout({ repoPath, parentDir, repoName, wtName, layout });
      branch = `agents/${wtName}`;
      windowName = windowNameForWorktree(wtName);
      const knownWorktree = existingWorktrees.some(w => w.name === wtName || w.path === wtPath);
      if (knownWorktree || existingWindowNames.has(windowName)) {
        nextNum++;
        continue;
      }
      releaseWorktreePathLock = await acquireWorktreePathLock(wtPath, d.hostExec);
      if (!releaseWorktreePathLock) {
        nextNum++;
        continue;
      }
      try {
        await d.hostExec(`git -C '${safe(repoPath)}' show-ref --verify --quiet 'refs/heads/${safe(branch)}'`);
        branchExists = true;
        if (d.fresh) {
          await releaseWorktreePathLock();
          releaseWorktreePathLock = null;
          nextNum++;
          continue;
        }
      } catch {
        branchExists = false;
      }
      allocated = true;
      break;
    }
  }

  if (!allocated || !wtName || !wtPath || !branch || !windowName) {
    throw new Error(`could not allocate worktree for ${name}`);
  }

  const addArgs = branchExists
    ? `'${safe(wtPath)}' '${safe(branch)}'`
    : `'${safe(wtPath)}' -b '${safe(branch)}'`;
  try {
    await d.hostExec(`git -C '${safe(repoPath)}' worktree add ${addArgs}`);
    await reconcileParentClaudeDir(repoPath, wtPath, d.log);
    writeWorktreeEngineFile(wtPath, d.engine, d.log);
    d.log(`\x1b[32m+\x1b[0m worktree: ${wtPath} (${branch}${branchExists ? ", reused branch" : ""})`);
    return { wtPath, windowName };
  } finally {
    await releaseWorktreePathLock?.();
  }
}
