/**
 * Direct tmux invocation via node:child_process — bg-pattern.
 *
 * The public @maw-js/sdk doesn't expose `tmux` as a top-level binding
 * (see Soul-Brews-Studio/maw-js#855). Rather than depend on internal
 * paths that aren't part of the SDK contract, community plugins call
 * tmux directly via spawnSync.
 */
import { spawnSync } from "node:child_process";

export interface TmuxWindow {
  index: number;
  name: string;
}

export function tmuxRun(...args: string[]): string {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (r.status !== 0) {
    const err = (r.stderr || "").trim() || `tmux ${args[0]} failed (exit ${r.status})`;
    throw new Error(err);
  }
  return (r.stdout || "").trim();
}

export function tmuxListWindows(session: string): TmuxWindow[] {
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
 * Send text to a tmux pane and submit Enter.
 *
 * Always uses load-buffer + paste-buffer (works for short and long, single
 * and multiline content). Stagger an extra Enter after a short delay to
 * paper over edge cases where the first one is consumed by an in-flight
 * keystroke handler.
 *
 * Faithful port of the maw-js tmux-class.ts sendText, simplified to a
 * single buffer path. Async because of the inter-keystroke delays.
 */
export async function tmuxSendText(target: string, text: string): Promise<void> {
  spawnSync("tmux", ["load-buffer", "-"], { input: text, encoding: "utf8" });
  spawnSync("tmux", ["paste-buffer", "-t", target]);
  await new Promise((r) => setTimeout(r, 1500));
  spawnSync("tmux", ["send-keys", "-t", target, "Enter"]);
  await new Promise((r) => setTimeout(r, 700));
  spawnSync("tmux", ["send-keys", "-t", target, "Enter"]);
}
