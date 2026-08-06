/**
 * `maw resume` — read a parked-window snapshot, send a recap-style prompt
 * to the parked window, and remove the file.
 *
 * Pairs with the `park` plugin which now lives at
 * Soul-Brews-Studio/maw-park. Snapshot file format is kept identical,
 * and legacy config-path snapshots remain readable for migration.
 *
 * cmdResume + a fallback cmdParkLs were inlined here as part of Path A.4
 * extraction (#640). Previously they lived in plugins/park/impl.ts and
 * were imported across plugin boundaries — that coupling is removed now
 * that park is a community plugin.
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

import { tmux } from "maw-js/sdk";
import { mawConfigPath, mawStatePath } from "../../../core/xdg";

function parkedDir(): string {
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

function parkedSnapshots(): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const dir of candidateParkedDirs()) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!snapshots.has(file)) snapshots.set(file, join(dir, file));
    }
  }
  return snapshots;
}

interface ParkedState {
  window: string;
  session: string;
  branch: string;
  cwd: string;
  lastCommit: string;
  dirtyFiles: string[];
  note: string;
  parkedAt: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Fallback list of parked snapshots, used when resume can't locate target. */
function listParked(): void {
  mkdirSync(parkedDir(), { recursive: true });
  const files = [...parkedSnapshots().values()];
  if (!files.length) { console.log("\x1b[90mno parked tabs\x1b[0m"); return; }

  console.log(`\n\x1b[36mPARKED\x1b[0m (${files.length}):\n`);
  for (const path of files) {
    const s: ParkedState = JSON.parse(readFileSync(path, "utf-8"));
    const ago = timeAgo(s.parkedAt);
    const dirty = s.dirtyFiles.length > 0 ? `\x1b[33m${s.dirtyFiles.length} dirty\x1b[0m` : "\x1b[32mclean\x1b[0m";
    const note = s.note ? `"${s.note}"` : "\x1b[90m(no note)\x1b[0m";
    console.log(`  \x1b[33m${s.window}\x1b[0m  ${note}  ${ago}  ${s.branch || "no branch"}  ${dirty}`);
  }
  console.log();
}

export async function cmdResume(target?: string): Promise<void> {
  mkdirSync(parkedDir(), { recursive: true });
  if (!target) { return listParked(); }

  // Find by tab number or window name
  const snapshots = parkedSnapshots();
  const files = [...snapshots.keys()];
  const num = parseInt(target);
  let filePath: string | null = null;
  let state: ParkedState | null = null;

  if (!isNaN(num)) {
    // By tab number — match against current session windows
    const session = (await tmux.run("display-message", "-p", "#S")).trim();
    const windows = await tmux.listWindows(session);
    const win = windows.find(w => w.index === num);
    if (win) {
      const f = `${win.name}.json`;
      if (files.includes(f)) {
        const path = snapshots.get(f);
        if (path) {
          filePath = path;
          state = JSON.parse(readFileSync(path, "utf-8"));
        }
      }
    }
  } else {
    // By name — exact or partial match
    const match = files.find(f => f === `${target}.json`) ||
                  files.find(f => f.toLowerCase().includes(target.toLowerCase()));
    if (match) {
      const path = snapshots.get(match);
      if (path) {
        filePath = path;
        state = JSON.parse(readFileSync(path, "utf-8"));
      }
    }
  }

  if (!state || !filePath) {
    console.error(`\x1b[31merror\x1b[0m: no parked state for '${target}'`);
    return listParked();
  }

  // Build resume prompt and send to the window
  const parts = [`Resuming parked work.`];
  if (state.note) parts.push(`Task: ${state.note}`);
  if (state.branch) parts.push(`Branch: ${state.branch}`);
  if (state.lastCommit) parts.push(`Last commit: ${state.lastCommit}`);
  if (state.dirtyFiles.length > 0) parts.push(`Dirty files: ${state.dirtyFiles.join(", ")}`);
  parts.push("Please /recap and continue where we left off.");

  const prompt = parts.join(" ");
  const windowTarget = `${state.session}:${state.window}`;
  await tmux.sendText(windowTarget, prompt);

  unlinkSync(filePath);
  console.log(`\x1b[32m✓\x1b[0m resumed \x1b[33m${state.window}\x1b[0m → sent context`);
}
