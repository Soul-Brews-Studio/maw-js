/**
 * maw park [<window>] [<note>] | maw park ls
 *
 * Park (pause) a tmux window — capture its current git context (branch,
 * last commit, dirty files) and an optional human-readable note, write
 * the snapshot to the maw state dir under parked/<window>.json. Resume
 * via the separate `maw resume` plugin (which reads the snapshot, sends
 * a recap-style prompt to the parked window, and removes the file).
 *
 * Tmux + git invoked via direct spawnSync (bg-pattern) — see
 * ./internal/tmux.ts and ./internal/git.ts. Public @maw-js/sdk doesn't
 * expose `tmux`/`hostExec` (Soul-Brews-Studio/maw-js#855).
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { tmuxRun, tmuxListWindows } from "./internal/tmux";
import { gitBranch, gitLastCommit, gitDirtyFiles } from "./internal/git";
import { mawConfigPath, mawStatePath } from "../../../../core/xdg";

export function parkedDir(): string {
  return mawStatePath("parked");
}

function legacyParkedDir(): string {
  return mawConfigPath("parked");
}

function candidateParkedDirs(): string[] {
  const dirs = [parkedDir()];
  const legacy = legacyParkedDir();
  if (legacy !== dirs[0]) dirs.push(legacy);
  return dirs;
}

export const PARKED_DIR = parkedDir();

export interface ParkedState {
  window: string;
  session: string;
  branch: string;
  cwd: string;
  lastCommit: string;
  dirtyFiles: string[];
  note: string;
  parkedAt: string;
}

function currentWindowInfo(): { session: string; window: string } {
  const session = tmuxRun("display-message", "-p", "#S");
  const window = tmuxRun("display-message", "-p", "#W");
  return { session, window };
}

/**
 * Format a parkedAt ISO timestamp as a coarse relative duration.
 * Exported for tests.
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Decide whether the first arg is a window name (target) or part of a note.
 * Pure logic — exported for tests.
 *
 *   resolvePark([], "current", [])              → { target: "current", note: undefined }
 *   resolvePark(["a note"], "cur", ["foo"])     → { target: "cur",     note: "a note" }
 *   resolvePark(["foo"], "cur", ["foo","bar"])  → { target: "foo",     note: undefined }
 *   resolvePark(["foo","x"], "cur", ["foo"])    → { target: "foo",     note: "x" }
 *
 * Rule: if the first arg matches a known non-current window name, it's the
 * target; remaining args become the note. Otherwise everything is the note.
 */
export function resolvePark(
  rawArgs: string[],
  currentWindow: string,
  knownWindowNames: string[],
): { target: string; note: string | undefined } {
  if (rawArgs.length === 0) {
    return { target: currentWindow, note: undefined };
  }
  const first = rawArgs[0];
  if (knownWindowNames.includes(first) && first !== currentWindow) {
    return { target: first, note: rawArgs.slice(1).join(" ") || undefined };
  }
  return { target: currentWindow, note: rawArgs.join(" ") || undefined };
}

export async function cmdPark(...rawArgs: string[]): Promise<void> {
  const { session, window: currentWindow } = currentWindowInfo();
  const windows = tmuxListWindows(session);
  const { target: targetWindow, note } = resolvePark(
    rawArgs,
    currentWindow,
    windows.map((w) => w.name),
  );

  // Get cwd of the target window's pane via tmux.
  const cwd = tmuxRun(
    "display-message",
    "-t",
    `${session}:${targetWindow}`,
    "-p",
    "#{pane_current_path}",
  );

  const state: ParkedState = {
    window: targetWindow,
    session,
    branch: gitBranch(cwd),
    cwd,
    lastCommit: gitLastCommit(cwd),
    dirtyFiles: gitDirtyFiles(cwd),
    note: note || "",
    parkedAt: new Date().toISOString(),
  };

  const dir = parkedDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${targetWindow}.json`), JSON.stringify(state, null, 2) + "\n");
  console.log(`\x1b[32m✓\x1b[0m parked \x1b[33m${targetWindow}\x1b[0m${note ? ` — "${note}"` : ""}`);
}

export async function cmdParkLs(): Promise<void> {
  const primary = parkedDir();
  mkdirSync(primary, { recursive: true });
  const snapshots = new Map<string, { dir: string; file: string }>();
  for (const dir of candidateParkedDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!snapshots.has(file)) snapshots.set(file, { dir, file });
    }
  }
  const files = [...snapshots.values()];
  if (!files.length) {
    console.log("\x1b[90mno parked tabs\x1b[0m");
    return;
  }

  console.log(`\n\x1b[36mPARKED\x1b[0m (${files.length}):\n`);
  for (const { dir, file } of files) {
    const s: ParkedState = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    const ago = timeAgo(s.parkedAt);
    const dirty = s.dirtyFiles.length > 0 ? `\x1b[33m${s.dirtyFiles.length} dirty\x1b[0m` : "\x1b[32mclean\x1b[0m";
    const note = s.note ? `"${s.note}"` : "\x1b[90m(no note)\x1b[0m";
    console.log(`  \x1b[33m${s.window}\x1b[0m  ${note}  ${ago}  ${s.branch || "no branch"}  ${dirty}`);
  }
  console.log();
}
