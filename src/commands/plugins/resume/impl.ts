/**
 * `maw resume` — read a parked-window snapshot, send a recap-style prompt
 * to the parked window, and remove the file.
 *
 * Pairs with the `park` plugin which now lives at
 * Soul-Brews-Studio/maw-park. Snapshot file format and PARKED_DIR
 * location are kept identical for forward/backward compatibility.
 *
 * cmdResume + a fallback cmdParkLs were inlined here as part of Path A.4
 * extraction (#640). Previously they lived in plugins/park/impl.ts and
 * were imported across plugin boundaries — that coupling is removed now
 * that park is a community plugin.
 */
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { tmux } from "../../../sdk";

const PARKED_DIR = join(homedir(), ".config/maw/parked");

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
  mkdirSync(PARKED_DIR, { recursive: true });
  const files = readdirSync(PARKED_DIR).filter(f => f.endsWith(".json"));
  if (!files.length) { console.log("\x1b[90mno parked tabs\x1b[0m"); return; }

  console.log(`\n\x1b[36mPARKED\x1b[0m (${files.length}):\n`);
  for (const f of files) {
    const s: ParkedState = JSON.parse(readFileSync(join(PARKED_DIR, f), "utf-8"));
    const ago = timeAgo(s.parkedAt);
    const dirty = s.dirtyFiles.length > 0 ? `\x1b[33m${s.dirtyFiles.length} dirty\x1b[0m` : "\x1b[32mclean\x1b[0m";
    const note = s.note ? `"${s.note}"` : "\x1b[90m(no note)\x1b[0m";
    console.log(`  \x1b[33m${s.window}\x1b[0m  ${note}  ${ago}  ${s.branch || "no branch"}  ${dirty}`);
  }
  console.log();
}

export async function cmdResume(target?: string): Promise<void> {
  mkdirSync(PARKED_DIR, { recursive: true });
  if (!target) { return listParked(); }

  // Find by tab number or window name
  const files = readdirSync(PARKED_DIR).filter(f => f.endsWith(".json"));
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
        filePath = join(PARKED_DIR, f);
        state = JSON.parse(readFileSync(filePath, "utf-8"));
      }
    }
  } else {
    // By name — exact or partial match
    const match = files.find(f => f === `${target}.json`) ||
                  files.find(f => f.toLowerCase().includes(target.toLowerCase()));
    if (match) {
      filePath = join(PARKED_DIR, match);
      state = JSON.parse(readFileSync(filePath, "utf-8"));
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
