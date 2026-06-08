import { basename, join } from "path";
import { parseWorktreePath } from "../../core/fleet/worktree-layout";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { listSessions, hostExec, tmux, takeSnapshot } from "../../sdk";
import { getGhqRoot } from "../../config/ghq-root";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { mawDataPath } from "../../core/xdg";
import { pruneJsonlFile } from "../../vendor/mpr-plugins/messages/retention";
import { fleetDirForWrite, fleetDirsForRead, uniqueDirs } from "../../core/fleet/paths";
import { inferRetrospectiveCommand } from "../../vendor/mpr-plugins/done/retrospective-command";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
  cleanBranch?: boolean;
  /** Skip all branch cleanup — keep the branch even when merged (#2073 --keep-branch). */
  keepBranch?: boolean;
  cwd?: string;
}

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

type DoneFs = {
  appendFileSync: typeof appendFileSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
};

type DoneLogger = Pick<typeof console, "error" | "log">;

export interface DoneDeps {
  listSessions?: () => Promise<SessionInfo[]>;
  hostExec?: (command: string) => Promise<string>;
  tmux?: {
    run?: (subcommand: string, ...args: (string | number)[]) => Promise<string>;
    killWindow?: (target: string) => Promise<unknown>;
    sendText?: (target: string, text: string) => Promise<unknown>;
  };
  fleetDir?: string;
  fleetDirs?: string[];
  ghqRoot?: string;
  homeDir?: string;
  inboxDir?: string;
  takeSnapshot?: (trigger: string) => Promise<unknown>;
  branchBase?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fs?: Partial<DoneFs>;
  logger?: DoneLogger;
}

function doneDeps(deps: DoneDeps = {}) {
  const homeDir = deps.homeDir ?? homedir();
  return {
    listSessions: deps.listSessions ?? (listSessions as () => Promise<SessionInfo[]>),
    hostExec: deps.hostExec ?? hostExec,
    tmux: {
      run: deps.tmux?.run ?? tmux.run.bind(tmux),
      killWindow: deps.tmux?.killWindow ?? tmux.killWindow,
      sendText: deps.tmux?.sendText ?? tmux.sendText,
    },
    fleetDir: deps.fleetDir ?? fleetDirForWrite(),
    fleetDirs: deps.fleetDirs ?? (deps.fleetDir ? [deps.fleetDir] : fleetDirsForRead()),
    ghqRoot: deps.ghqRoot ?? getGhqRoot(),
    homeDir,
    inboxDir: deps.inboxDir ?? mawDataPath("inbox"),
    takeSnapshot: deps.takeSnapshot ?? takeSnapshot,
    branchBase: deps.branchBase,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? Bun.sleep,
    fs: {
      appendFileSync: deps.fs?.appendFileSync ?? appendFileSync,
      mkdirSync: deps.fs?.mkdirSync ?? mkdirSync,
      readdirSync: deps.fs?.readdirSync ?? readdirSync,
      readFileSync: deps.fs?.readFileSync ?? readFileSync,
      writeFileSync: deps.fs?.writeFileSync ?? writeFileSync,
    },
    logger: deps.logger ?? console,
  };
}

type ResolvedDoneDeps = ReturnType<typeof doneDeps>;

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class DirtyWorktreeRemovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeRemovalError";
  }
}

async function dirExists(path: string, d: ResolvedDoneDeps): Promise<boolean> {
  try {
    await d.hostExec(`test -d ${shellArg(path)}`);
    return true;
  } catch {
    return false;
  }
}

async function removeFailedWorktreeDir(
  wtPath: string,
  mainPath: string,
  originalError: unknown,
  opts: DoneOpts,
  d: ResolvedDoneDeps,
): Promise<boolean> {
  if (!(await dirExists(wtPath, d))) return false;

  let status = "";
  let statusKnown = false;
  try {
    status = await d.hostExec(`git -C ${shellArg(wtPath)} status --porcelain --untracked-files=all`);
    statusKnown = true;
  } catch (e: any) {
    if (!opts.force) {
      throw new DirtyWorktreeRemovalError(
        `worktree remove failed and ${wtPath} could not be checked for local changes (${e?.message || e}); rerun with --force to delete it`,
      );
    }
    d.logger.log(`  \x1b[33m⚠\x1b[0m deleting ${basename(wtPath)} with --force after status check failed: ${e?.message || e}`);
  }

  const dirty = status.trim().length > 0;
  if (dirty && !opts.force) {
    throw new DirtyWorktreeRemovalError(
      `worktree remove failed and ${wtPath} has uncommitted changes; rerun maw done --force to delete it`,
    );
  }

  try {
    await d.hostExec(`rm -rf ${shellArg(wtPath)}`);
    await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
    const suffix = dirty
      ? " with --force despite uncommitted changes"
      : statusKnown
        ? " after verifying it was clean"
        : " with --force after status check failed";
    d.logger.log(`  \x1b[32m✓\x1b[0m removed orphan directory ${basename(wtPath)}${suffix}`);
    return true;
  } catch (e: any) {
    d.logger.log(`  \x1b[33m⚠\x1b[0m orphan directory removal failed after worktree remove failed (${e?.message || e}); original error: ${originalError instanceof Error ? originalError.message : originalError}`);
    return false;
  }
}

async function findMatchingWorktreePaths(
  windowName: string,
  reposRoot: string,
  d: ResolvedDoneDeps,
): Promise<string[]> {
  const suffix = windowName.replace(/^[^-]+-/, "");
  const ghqOut = await d.hostExec(`find ${shellArg(reposRoot)} -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
  const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
  return allWtPaths.filter(p => {
    const parsed = parseWorktreePath(p, reposRoot);
    if (!parsed) return false;
    const wtSuffix = parsed.wtName.replace(/^\d+-/, "");
    return wtSuffix.toLowerCase() === suffix.toLowerCase();
  });
}

async function cwdMainPath(cwd: string | undefined, reposRoot: string, d: ResolvedDoneDeps): Promise<string | null> {
  if (!cwd) return null;
  try {
    const top = (await d.hostExec(`git -C ${shellArg(cwd)} rev-parse --show-toplevel`)).trim();
    if (!top) return null;
    const parsed = parseWorktreePath(top, reposRoot);
    return parsed?.mainPath ?? top;
  } catch {
    return null;
  }
}

function branchBaseFor(mainPath: string, d: ResolvedDoneDeps): string {
  if (d.branchBase) return d.branchBase;
  const normalized = mainPath.split("\\").join("/");
  if (normalized.endsWith("/Soul-Brews-Studio/maw-js") || normalized.includes("/github.com/Soul-Brews-Studio/maw-js")) {
    return "alpha";
  }
  return "main";
}

function isProtectedBranch(branch: string, baseBranch: string): boolean {
  return branch === "HEAD" || branch === "main" || branch === "master" || branch === "alpha" || branch === baseBranch;
}

async function ghMergedPrExists(branch: string, d: ResolvedDoneDeps): Promise<"yes" | "no" | "unavailable"> {
  try {
    const out = await d.hostExec(`gh pr list --head ${shellArg(branch)} --state merged --json number --limit 1`);
    const parsed = JSON.parse(out || "[]");
    return Array.isArray(parsed) && parsed.length > 0 ? "yes" : "no";
  } catch {
    return "unavailable";
  }
}

export async function cleanupDoneBranch(
  mainPath: string,
  branch: string,
  opts: DoneOpts = {},
  deps: DoneDeps = {},
): Promise<void> {
  const d = doneDeps(deps);
  if (opts.keepBranch) {
    if (branch) d.logger.log(`  \x1b[36m⬡\x1b[0m kept branch ${branch} (--keep-branch)`);
    return;
  }
  const cleanBranch = Boolean(opts.cleanBranch);
  const baseBranch = branchBaseFor(mainPath, d);
  if (!branch || isProtectedBranch(branch, baseBranch)) return;

  const quotedMain = shellArg(mainPath);
  const quotedBranch = shellArg(branch);
  if (cleanBranch) {
    try {
      await d.hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      d.logger.log(`  \x1b[32m✓\x1b[0m force-deleted branch ${branch}`);
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): force delete failed: ${e?.message || e}`);
    }
    return;
  }

  try {
    await d.hostExec(`git -C ${quotedMain} merge-base --is-ancestor ${quotedBranch} ${shellArg(baseBranch)}`);
    await d.hostExec(`git -C ${quotedMain} branch -d ${quotedBranch}`);
    d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged into ${baseBranch})`);
    return;
  } catch {
    // Not an ancestor of the configured base, or local refs are unavailable.
  }

  const prState = await ghMergedPrExists(branch, d);
  if (prState === "yes") {
    try {
      await d.hostExec(`git -C ${quotedMain} branch -D ${quotedBranch}`);
      d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch} (merged PR)`);
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): delete failed after merged PR proof: ${e?.message || e}`);
    }
    return;
  }

  if (prState === "unavailable") {
    d.logger.log(`  \x1b[33m⚠\x1b[0m branch retained (${branch}): gh unavailable and not merged into ${baseBranch}`);
  } else {
    d.logger.log(`  \x1b[90m○\x1b[0m branch retained (${branch}): not merged into ${baseBranch} and no merged PR found`);
  }
}

function missingDoneTargetMessage(windowName: string): string {
  const hint = windowName.toLowerCase() === "all" ? "\n  did you mean `maw done --all`?" : "";
  return `no done target matched '${windowName}'${hint}`;
}

function failMissingDoneTarget(windowName: string, d: ResolvedDoneDeps): never {
  const message = missingDoneTargetMessage(windowName);
  d.logger.error(`  \x1b[31m✗\x1b[0m ${message}`);
  throw new Error(message);
}

function leadWindow(session: SessionInfo): SessionInfo["windows"][number] | null {
  if (session.windows.length === 0) return null;
  const leadIndex = Math.min(...session.windows.map(w => w.index));
  return session.windows.find(w => w.index === leadIndex) ?? null;
}

async function currentTmuxIdentity(d: ResolvedDoneDeps): Promise<{ sessionName: string; windowIndex: number } | null> {
  try {
    const raw = (await d.tmux.run("display-message", "-p", "#{session_name}\t#{window_index}")).trim();
    const [sessionName, indexRaw] = raw.split("\t");
    const windowIndex = Number(indexRaw);
    if (sessionName && Number.isInteger(windowIndex)) return { sessionName, windowIndex };
  } catch {
    // Outside tmux or tmux unavailable. Treat as non-lead for the guard.
  }
  return null;
}

async function assertDoneMayTargetWindow(
  session: SessionInfo,
  windowIndex: number,
  windowName: string,
  d: ResolvedDoneDeps,
): Promise<void> {
  const lead = leadWindow(session);
  if (!lead || lead.index !== windowIndex) return;

  const current = await currentTmuxIdentity(d);
  if (current?.sessionName === session.name && current.windowIndex === lead.index) return;

  const message = `refusing to done lead window '${windowName}' in session '${session.name}' from a non-lead context`;
  d.logger.error(`  \x1b[31m✗\x1b[0m ${message}`);
  d.logger.error(`  \x1b[90m  run from the lead window, or target a non-lead agent window\x1b[0m`);
  throw new Error(message);
}

function activeFleetConfigFiles(d: ResolvedDoneDeps): Array<{ file: string; path: string }> {
  const filesByName = new Map<string, { file: string; path: string }>();
  const dirs = uniqueDirs(d.fleetDirs?.length ? d.fleetDirs : [d.fleetDir]);
  let sawReadableDir = false;
  let lastError: unknown = null;

  for (const fleetDir of dirs) {
    let files: string[];
    try {
      files = d.fs.readdirSync(fleetDir).filter(f => f.endsWith(".json")).sort();
      sawReadableDir = true;
    } catch (error) {
      lastError = error;
      continue;
    }

    for (const file of files) {
      if (!filesByName.has(file)) filesByName.set(file, { file, path: join(fleetDir, file) });
    }
  }

  if (!sawReadableDir && lastError) throw lastError;
  return [...filesByName.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export async function cmdDone(windowName_: string, opts: DoneOpts = {}, deps: DoneDeps = {}) {
  const d = doneDeps(deps);
  let windowName = normalizeTarget(windowName_);
  const sessions = await d.listSessions();
  const reposRoot = join(d.ghqRoot, "github.com");

  const windowNameLower = windowName.toLowerCase();
  let sessionName: string | null = null;
  let matchedSession: SessionInfo | null = null;
  let windowIndex: number | null = null;
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; matchedSession = s; windowIndex = w.index; windowName = w.name; break; }
  }

  if (matchedSession && windowIndex !== null) {
    await assertDoneMayTargetWindow(matchedSession, windowIndex, windowName, d);
  }

  if (sessionName) {
    signalParentInbox(windowName, sessionName, sessions, deps);
  }

  if (sessionName !== null && windowIndex !== null && !opts.force) {
    await autoSave(windowName, sessionName, opts, deps);
    if (opts.dryRun) return;
  } else if (opts.dryRun) {
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] window '${windowName}' not running — nothing to auto-save`);
  }

  if (sessionName !== null && windowIndex !== null) {
    try {
      await d.tmux.killWindow(`${sessionName}:${windowName}`);
      d.logger.log(`  \x1b[32m✓\x1b[0m killed window ${sessionName}:${windowName}`);
    } catch {
      d.logger.log(`  \x1b[33m⚠\x1b[0m could not kill window (may already be closed)`);
    }
  } else {
    d.logger.log(`  \x1b[90m○\x1b[0m window '${windowName}' not running`);
  }

  let removedWorktree = await removeWorktreeViaConfig(windowNameLower, reposRoot, deps, opts);
  if (!removedWorktree) {
    removedWorktree = await removeWorktreeByGhqScan(windowName, reposRoot, deps, opts);
  }
  if (!removedWorktree) {
    d.logger.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  } else if (!opts.dryRun && opts.cwd) {
    await warnRemainingWorktrees(windowName, reposRoot, deps);
  }

  const matchedWindow = sessionName !== null && windowIndex !== null;
  if (opts.dryRun) {
    if (!matchedWindow && !removedWorktree) failMissingDoneTarget(windowName, d);
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove '${windowNameLower}' from fleet config if present`);
    d.logger.log();
    return;
  }

  const removedFromConfig = removeFromFleetConfig(windowNameLower, deps);
  if (!removedFromConfig) {
    d.logger.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }
  if (!matchedWindow && !removedWorktree && !removedFromConfig) failMissingDoneTarget(windowName, d);

  d.takeSnapshot("done").catch(() => {});
  d.logger.log();
}

export function signalParentInbox(
  windowName: string,
  sessionName: string,
  sessions: SessionInfo[],
  deps: DoneDeps = {},
): void {
  const d = doneDeps(deps);
  const from = process.env.CLAUDE_AGENT_NAME || windowName;
  const parentWindow = sessions.find(s => s.name === sessionName)?.windows[0]?.name;
  if (!parentWindow) return;
  const parentTarget = parentWindow.replace(/[^a-zA-Z0-9_-]/g, "");
  const inboxDir = d.inboxDir;
  const signal =
    JSON.stringify({ ts: d.now().toISOString(), from, type: "done", msg: `worktree ${windowName} completed`, thread: null }) + "\n";
  try {
    d.fs.mkdirSync(inboxDir, { recursive: true });
    const signalPath = join(inboxDir, `${parentTarget}.jsonl`);
    d.fs.appendFileSync(signalPath, signal);
    pruneJsonlFile(signalPath);
  } catch (e) {
    d.logger.error(`  \x1b[33m⚠\x1b[0m inbox signal failed: ${e}`);
  }
}

export async function autoSave(
  windowName: string,
  sessionName: string,
  opts: DoneOpts,
  deps: DoneDeps = {},
): Promise<void> {
  const d = doneDeps(deps);
  const target = `${sessionName}:${windowName}`;

  let paneCwd = "";
  let paneCurrentCommand = "";
  try {
    const paneInfo = await d.hostExec(`tmux display-message -t '${target}' -p '#{pane_current_command}\t#{pane_current_path}'`);
    const [rawPaneCommand, rawPanePath] = paneInfo.split("\t");
    paneCurrentCommand = (rawPaneCommand ?? "").trim();
    paneCwd = (rawPanePath ?? "").trim();
  } catch { /* pane may not exist */ }

  const retrospectiveCommand = inferRetrospectiveCommand(paneCurrentCommand);

  if (opts.dryRun) {
    if (retrospectiveCommand) {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send ${retrospectiveCommand} to ${target} and wait 10s`);
    } else {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would skip retro (no retrospective command for this engine)`);
    }
    if (paneCwd) {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would kill window ${target}`);
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree + fleet config`);
    d.logger.log();
    return;
  }

  if (retrospectiveCommand) {
    d.logger.log(`  \x1b[36m⏳\x1b[0m sending ${retrospectiveCommand} to ${target}...`);
    try {
      await d.tmux.sendText(target, retrospectiveCommand);
      await d.sleep(10_000);
      d.logger.log(`  \x1b[32m✓\x1b[0m ${retrospectiveCommand} sent (waited 10s)`);
    } catch {
      d.logger.log(`  \x1b[33m⚠\x1b[0m could not send ${retrospectiveCommand} (agent may not be running)`);
    }
  } else {
    d.logger.log(`  \x1b[90m○\x1b[0m no retrospective command for this engine — skipping retro`);
  }

  if (paneCwd) {
    d.logger.log(`  \x1b[36m⏳\x1b[0m git auto-save in ${paneCwd}...`);
    try {
      await d.hostExec(`git -C '${paneCwd}' add -A`);
      try {
        await d.hostExec(`git -C '${paneCwd}' commit -m 'chore: auto-save before done'`);
        d.logger.log(`  \x1b[32m✓\x1b[0m committed changes`);
      } catch {
        d.logger.log(`  \x1b[90m○\x1b[0m nothing to commit`);
      }
      try {
        await d.hostExec(`git -C '${paneCwd}' push`);
        d.logger.log(`  \x1b[32m✓\x1b[0m pushed to remote`);
      } catch {
        d.logger.log(`  \x1b[33m⚠\x1b[0m push failed (no remote or auth issue)`);
      }
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m git auto-save failed: ${e.message || e}`);
    }
  }
}

export async function removeWorktreeViaConfig(
  windowNameLower: string,
  reposRoot: string,
  deps: DoneDeps = {},
  opts: DoneOpts = {},
): Promise<boolean> {
  const d = doneDeps(deps);
  try {
    for (const { file, path } of activeFleetConfigFiles(d)) {
      let config: any;
      try {
        config = JSON.parse(d.fs.readFileSync(path, "utf-8"));
      } catch { continue; }
      const win = (config.windows || []).find((w: any) => w.name.toLowerCase() === windowNameLower);
      if (!win?.repo) continue;

      const fullPath = join(reposRoot, win.repo);
      const parsed = parseWorktreePath(fullPath, reposRoot);
      if (!parsed) break;

      const mainPath = parsed.mainPath;

      try {
        if (opts.dryRun) {
          d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${win.repo}`);
          return true;
        }
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        // #1968: force removes ignored engine scratch (for example .omx/) left in finished worktrees.
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(fullPath)} --force`);
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
        if (branch && branch !== "main" && branch !== "HEAD") {
          await cleanupDoneBranch(mainPath, branch, opts, deps);
        }
        return true;
      } catch (e: any) {
        if (await removeFailedWorktreeDir(fullPath, mainPath, e, opts, d)) {
          return true;
        }
        d.logger.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
      }
      break;
    }
  } catch (e) {
    if (e instanceof DirtyWorktreeRemovalError) throw e;
    d.logger.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`);
  }
  return false;
}

export async function removeWorktreeByGhqScan(
  windowName: string,
  reposRoot: string,
  deps: DoneDeps = {},
  opts: DoneOpts = {},
): Promise<boolean> {
  const d = doneDeps(deps);
  let removed = false;
  try {
    const suffix = windowName.replace(/^[^-]+-/, "");
    const exactMatch = await findMatchingWorktreePaths(windowName, reposRoot, d);
    let matches = exactMatch;
    if (matches.length > 1) {
      const mainPath = await cwdMainPath(opts.cwd, reposRoot, d);
      if (mainPath) {
        const scoped = matches.filter((p) => parseWorktreePath(p, reposRoot)?.mainPath === mainPath);
        if (scoped.length === 1) {
          matches = scoped;
          d.logger.log(`  \x1b[36m⬡\x1b[0m scoped ambiguous worktree '${suffix}' to cwd repo ${mainPath}`);
        }
      }
    }
    if (matches.length > 1) {
      d.logger.error(`  \x1b[31m✗\x1b[0m refusing to remove worktree '${suffix}' — matches ${matches.length} repos:`);
      for (const wtPath of matches) d.logger.error(`  \x1b[90m    • ${wtPath}\x1b[0m`);
      d.logger.error(`  \x1b[90m  use fleet config or remove the exact worktree manually\x1b[0m`);
      return false;
    }
    for (const wtPath of matches) {
      const base = basename(wtPath);
      const parsed = parseWorktreePath(wtPath, reposRoot);
      if (!parsed) continue;
      const mainPath = parsed.mainPath;
      try {
        if (opts.dryRun) {
          d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree ${base}`);
          removed = true;
          continue;
        }
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        // #1968: force removes ignored engine scratch (for example .omx/) left in finished worktrees.
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree remove ${shellArg(wtPath)} --force`);
        await d.hostExec(`git -C ${shellArg(mainPath)} worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        if (branch && branch !== "main" && branch !== "HEAD") {
          await cleanupDoneBranch(mainPath, branch, opts, deps);
        }
      } catch (e) {
        if (await removeFailedWorktreeDir(wtPath, mainPath, e, opts, d)) {
          removed = true;
          continue;
        }
        d.logger.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`);
      }
    }
  } catch (e) {
    if (e instanceof DirtyWorktreeRemovalError) throw e;
    d.logger.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`);
  }
  return removed;
}

export async function warnRemainingWorktrees(
  windowName: string,
  reposRoot: string,
  deps: DoneDeps = {},
): Promise<string[]> {
  const d = doneDeps(deps);
  let matches: string[] = [];
  try {
    matches = await findMatchingWorktreePaths(windowName, reposRoot, d);
  } catch (e: any) {
    d.logger.log(`  \x1b[33m⚠\x1b[0m cross-repo worktree scan failed: ${e?.message || e}`);
    return [];
  }
  if (matches.length === 0) return [];

  d.logger.log(`  \x1b[33m⚠\x1b[0m ${matches.length} same-member worktree(s) still exist in other repo(s):`);
  for (const match of matches) d.logger.log(`  \x1b[90m    • ${match}\x1b[0m`);
  d.logger.log(`  \x1b[90m  inspect them or run maw cleanup --worktrees before respawning\x1b[0m`);
  return matches;
}

export function removeFromFleetConfig(windowNameLower: string, deps: DoneDeps = {}): boolean {
  const d = doneDeps(deps);
  let removed = false;
  try {
    for (const { file, path: filePath } of activeFleetConfigFiles(d)) {
      const config = JSON.parse(d.fs.readFileSync(filePath, "utf-8"));
      const before = config.windows?.length || 0;
      config.windows = (config.windows || []).filter((w: any) => w.name.toLowerCase() !== windowNameLower);
      if (config.windows.length < before) {
        d.fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
        d.logger.log(`  \x1b[32m✓\x1b[0m removed from ${file}`);
        removed = true;
      }
    }
  } catch { /* fleet dir may not exist */ }
  return removed;
}
