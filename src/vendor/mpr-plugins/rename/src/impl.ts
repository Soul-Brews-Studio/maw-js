/**
 * maw rename <tab-number-or-name> <new-name>
 *
 * Rename a window in the current tmux session, auto-prefixing with the
 * oracle name extracted from the session.
 *
 * Tmux is invoked via `node:child_process.spawnSync` (bg-pattern shipped
 * in maw-bg) — the public `@maw-js/sdk` doesn't expose tmux directly
 * (see Soul-Brews-Studio/maw-js#855).
 */
import { spawnSync } from "node:child_process";

export interface TmuxWindow {
  index: number;
  name: string;
}

function tmuxRun(...args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.status !== 0) {
    const err = (r.stderr || "").trim() || `tmux ${args[0]} failed (exit ${r.status})`;
    throw new Error(err);
  }
  return (r.stdout || "").trim();
}

function listWindows(session: string): TmuxWindow[] {
  const out = tmuxRun("list-windows", "-t", session, "-F", "#I:#W");
  if (!out) return [];
  return out.split("\n").map((line) => {
    const idx = line.indexOf(":");
    return {
      index: parseInt(line.slice(0, idx), 10),
      name: line.slice(idx + 1),
    };
  });
}

/**
 * Auto-prefix newName with the oracle name derived from session.
 * Sessions like "03-neo" → oracle "neo"; bare "neo" → oracle "neo".
 * If newName already starts with `${oracle}-`, returns it unchanged.
 *
 * Exported for tests + future reuse.
 */
export function autoPrefix(session: string, newName: string): string {
  const oracle = session.replace(/^\d+-/, "");
  return newName.startsWith(`${oracle}-`) ? newName : `${oracle}-${newName}`;
}

export async function cmdRename(target: string, newName: string): Promise<void> {
  const session = tmuxRun("display-message", "-p", "#S");
  const windows = listWindows(session);

  // Find by number or name
  const num = parseInt(target, 10);
  const win = !isNaN(num)
    ? windows.find((w) => w.index === num)
    : windows.find((w) => w.name === target);

  if (!win) {
    console.error(`tabs: ${windows.map((w) => `${w.index}:${w.name}`).join(", ")}`);
    throw new Error(`tab ${target} not found in ${session}`);
  }

  const fullName = autoPrefix(session, newName);

  tmuxRun("rename-window", "-t", `${session}:${win.index}`, fullName);
  console.log(`\x1b[32m✓\x1b[0m tab ${win.index} \x1b[33m${win.name}\x1b[0m → \x1b[33m${fullName}\x1b[0m`);
}
