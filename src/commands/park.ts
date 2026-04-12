import { tmux } from "../tmux";
import { hostExec } from "../ssh";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

async function currentWindowInfo(): Promise<{ session: string; window: string }> {
  const session = (await tmux.run("display-message", "-p", "#S")).trim();
  const window = (await tmux.run("display-message", "-p", "#W")).trim();
  return { session, window };
}

export async function cmdPark(...rawArgs: string[]) {
  const { session, window: currentWindow } = await currentWindowInfo();

  // Determine target window and note:
  // - maw park → park current window
  // - maw park "note" → park current window with note (if arg doesn't match a window)
  // - maw park <window-name> → park that window
  // - maw park <window-name> "note" → park that window with note
  let targetWindow = currentWindow;
  let note: string | undefined;

  if (rawArgs.length > 0) {
    const firstArg = rawArgs[0];
    // Check if first arg matches a known tmux window name
    const windows = await tmux.listWindows(session);
    const windowNames = windows.map(w => w.name);
    if (windowNames.includes(firstArg) && firstArg !== currentWindow) {
      targetWindow = firstArg;
      note = rawArgs.slice(1).join(" ") || undefined;
    } else {
      // Treat all args as note
      note = rawArgs.join(" ") || undefined;
    }
  }

  // Get git context from target window's pane cwd
  const cwd = (await tmux.run("display-message", "-t", `${session}:${targetWindow}`, "-p", "#{pane_current_path}")).trim();
  let branch = "", lastCommit = "", dirtyFiles: string[] = [];
  const safeCwd = cwd.replace(/'/g, "'\\''");
  try { branch = (await hostExec(`git -C '${safeCwd}' branch --show-current 2>/dev/null`)).trim(); } catch { /* expected: may not be a git dir */ }
  try { lastCommit = (await hostExec(`git -C '${safeCwd}' log -1 --oneline 2>/dev/null`)).trim(); } catch { /* expected: may not be a git dir */ }
  try {
    const status = (await hostExec(`git -C '${safeCwd}' status --short 2>/dev/null`)).trim();
    dirtyFiles = status ? status.split("\n").map(l => l.trim()) : [];
  } catch { /* expected: may not be a git dir */ }

  const state: ParkedState = {
    window: targetWindow, session, branch, cwd, lastCommit, dirtyFiles,
    note: note || "",
    parkedAt: new Date().toISOString(),
  };

  mkdirSync(PARKED_DIR, { recursive: true });
  writeFileSync(join(PARKED_DIR, `${targetWindow}.json`), JSON.stringify(state, null, 2) + "\n");
  console.log(`\x1b[32m✓\x1b[0m parked \x1b[33m${targetWindow}\x1b[0m${note ? ` — "${note}"` : ""}`);
}

export async function cmdParkLs() {
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

export async function cmdResume(target?: string) {
  mkdirSync(PARKED_DIR, { recursive: true });
  if (!target) { return cmdParkLs(); }

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
    return cmdParkLs();
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

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
