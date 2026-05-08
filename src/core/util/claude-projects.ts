/**
 * Helpers for the Claude Code projects directory layout.
 *
 * Claude stores each project's session JSONLs under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the cwd
 * encoding replaces `/` and `.` with `-`. We use the encoding to find
 * sessions that match a target worktree, and the existence-check to
 * detect "no prior conversation" so wake doesn't emit `claude --continue`
 * into a fresh cwd (which exits 0 with "No conversation found to continue"
 * — the `||` fallback never fires and the pane is left empty).
 */
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Encode a cwd path the way Claude Code does for its projects directory:
 * `/` and `.` are both replaced with `-`. Idempotent — already-encoded
 * names map to themselves.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * True iff `~/.claude/projects/<encoded-cwd>/` contains at least one
 * `.jsonl` file. Used by buildCommandInDir to decide whether to inject
 * `--continue` (would silently fail in a cwd with no prior session).
 */
export function hasContinuableSession(cwd: string): boolean {
  const dir = join(homedir(), ".claude", "projects", encodeCwd(cwd));
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(f => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
