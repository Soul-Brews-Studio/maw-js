import { basename, join } from "path";
import { parseWorktreePath } from "../../core/fleet/worktree-layout";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { listSessions, hostExec, tmux, takeSnapshot } from "../../sdk";
import { getGhqRoot } from "../../config/ghq-root";
import { normalizeTarget } from "../../core/matcher/normalize-target";
import { mawDataPath } from "../../core/xdg";
import { fleetDirForWrite, fleetDirsForRead, uniqueDirs } from "../../core/fleet/paths";

export interface DoneOpts {
  force?: boolean;
  dryRun?: boolean;
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
    killWindow?: (target: string) => Promise<unknown>;
    sendText?: (target: string, text: string) => Promise<unknown>;
  };
  fleetDir?: string;
  fleetDirs?: string[];
  ghqRoot?: string;
  homeDir?: string;
  inboxDir?: string;
  takeSnapshot?: (trigger: string) => Promise<unknown>;
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
      killWindow: deps.tmux?.killWindow ?? tmux.killWindow,
      sendText: deps.tmux?.sendText ?? tmux.sendText,
    },
    fleetDir: deps.fleetDir ?? fleetDirForWrite(),
    fleetDirs: deps.fleetDirs ?? (deps.fleetDir ? [deps.fleetDir] : fleetDirsForRead()),
    ghqRoot: deps.ghqRoot ?? getGhqRoot(),
    homeDir,
    inboxDir: deps.inboxDir ?? mawDataPath("inbox"),
    takeSnapshot: deps.takeSnapshot ?? takeSnapshot,
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
  let windowIndex: number | null = null;
  for (const s of sessions) {
    const w = s.windows.find(w => w.name.toLowerCase() === windowNameLower);
    if (w) { sessionName = s.name; windowIndex = w.index; windowName = w.name; break; }
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

  let removedWorktree = await removeWorktreeViaConfig(windowNameLower, reposRoot, deps);
  if (!removedWorktree) {
    removedWorktree = await removeWorktreeByGhqScan(windowName, reposRoot, deps);
  }
  if (!removedWorktree) {
    d.logger.log(`  \x1b[90m○\x1b[0m no worktree to remove (may be a main window)`);
  }

  const removedFromConfig = removeFromFleetConfig(windowNameLower, deps);
  if (!removedFromConfig) {
    d.logger.log(`  \x1b[90m○\x1b[0m not in any fleet config`);
  }

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
    d.fs.appendFileSync(join(inboxDir, `${parentTarget}.jsonl`), signal);
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
  try {
    paneCwd = (await d.hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`)).trim();
  } catch { /* pane may not exist */ }

  if (opts.dryRun) {
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send /rrr to ${target} and wait 10s`);
    if (paneCwd) {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would kill window ${target}`);
    d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree + fleet config`);
    d.logger.log();
    return;
  }

  d.logger.log(`  \x1b[36m⏳\x1b[0m sending /rrr to ${target}...`);
  try {
    await d.tmux.sendText(target, "/rrr");
    await d.sleep(10_000);
    d.logger.log(`  \x1b[32m✓\x1b[0m /rrr sent (waited 10s)`);
  } catch {
    d.logger.log(`  \x1b[33m⚠\x1b[0m could not send /rrr (agent may not be running)`);
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
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${fullPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await d.hostExec(`git -C '${mainPath}' worktree remove '${fullPath}' --force`);
        await d.hostExec(`git -C '${mainPath}' worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${win.repo}`);
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await d.hostExec(`git -C '${mainPath}' branch -d '${branch}'`); d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
        return true;
      } catch (e: any) {
        d.logger.log(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e.message || e}`);
      }
      break;
    }
  } catch (e) { d.logger.error(`  \x1b[33m⚠\x1b[0m fleet scan failed: ${e}`); }
  return false;
}

export async function removeWorktreeByGhqScan(
  windowName: string,
  reposRoot: string,
  deps: DoneDeps = {},
): Promise<boolean> {
  const d = doneDeps(deps);
  let removed = false;
  try {
    const suffix = windowName.replace(/^[^-]+-/, "");
    const safeRoot = reposRoot.replace(/'/g, "'\''");
    const ghqOut = await d.hostExec(`find '${safeRoot}' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null`);
    const allWtPaths = ghqOut.trim().split("\n").filter(Boolean);
    const exactMatch = allWtPaths.filter(p => {
      const parsed = parseWorktreePath(p, reposRoot);
      if (!parsed) return false;
      const wtSuffix = parsed.wtName.replace(/^\d+-/, "");
      return wtSuffix.toLowerCase() === suffix.toLowerCase();
    });
    if (exactMatch.length > 1) {
      d.logger.error(`  \x1b[31m✗\x1b[0m refusing to remove worktree '${suffix}' — matches ${exactMatch.length} repos:`);
      for (const wtPath of exactMatch) d.logger.error(`  \x1b[90m    • ${wtPath}\x1b[0m`);
      d.logger.error(`  \x1b[90m  use fleet config or remove the exact worktree manually\x1b[0m`);
      return false;
    }
    for (const wtPath of exactMatch) {
      const base = basename(wtPath);
      const parsed = parseWorktreePath(wtPath, reposRoot);
      if (!parsed) continue;
      const mainPath = parsed.mainPath;
      try {
        let branch = "";
        try { branch = (await d.hostExec(`git -C '${wtPath}' rev-parse --abbrev-ref HEAD`)).trim(); } catch { /* expected */ }
        await d.hostExec(`git -C '${mainPath}' worktree remove '${wtPath}' --force`);
        await d.hostExec(`git -C '${mainPath}' worktree prune`);
        d.logger.log(`  \x1b[32m✓\x1b[0m removed worktree ${base}`);
        removed = true;
        if (branch && branch !== "main" && branch !== "HEAD") {
          try { await d.hostExec(`git -C '${mainPath}' branch -d '${branch}'`); d.logger.log(`  \x1b[32m✓\x1b[0m deleted branch ${branch}`); } catch { /* expected */ }
        }
      } catch (e) { d.logger.error(`  \x1b[33m⚠\x1b[0m worktree remove failed: ${e}`); }
    }
  } catch (e) { d.logger.error(`  \x1b[33m⚠\x1b[0m worktree scan failed: ${e}`); }
  return removed;
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
