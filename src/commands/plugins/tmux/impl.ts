import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../../../sdk";

const TEAMS_DIR = join(homedir(), ".claude/teams");

export interface TmuxPeekOpts {
  /** Number of lines from bottom of pane buffer. Default 30. */
  lines?: number;
  /** Include full scrollback (-S -). Overrides --lines. */
  history?: boolean;
}

/**
 * Resolve a user-supplied target into a tmux pane identifier suitable for
 * `tmux capture-pane -pt <id>`.
 *
 * Resolution order:
 *   1. Pane ID literal (e.g. "%776")
 *   2. Fully-qualified session:w.p (e.g. "101-mawjs:0.1")
 *   3. Team agent name → walk ~/.claude/teams/* /config.json, find member
 *   4. Bare session name → <target>:0 (pane 0)
 *
 * Returns the resolved target and a human-readable "how I found it" note.
 */
export function resolveTmuxTarget(target: string): { resolved: string; source: string } | null {
  // 1. Pane ID
  if (/^%\d+$/.test(target)) return { resolved: target, source: "pane-id" };

  // 2. session:w.p
  if (/^[\w.-]+:\d+\.\d+$/.test(target)) return { resolved: target, source: "session:w.p" };

  // 3. Team agent name — walk team configs
  if (existsSync(TEAMS_DIR)) {
    for (const dir of readdirSync(TEAMS_DIR)) {
      const cfg = join(TEAMS_DIR, dir, "config.json");
      if (!existsSync(cfg)) continue;
      try {
        const team = JSON.parse(readFileSync(cfg, "utf-8"));
        for (const m of team.members ?? []) {
          if (m?.name === target && m?.tmuxPaneId && m.tmuxPaneId !== "" && m.tmuxPaneId !== "in-process") {
            return { resolved: m.tmuxPaneId, source: `team-agent (${dir})` };
          }
        }
      } catch { /* skip bad config */ }
    }
  }

  // 4. Bare session name → pane 0
  return { resolved: `${target}:0`, source: "session-name (pane 0)" };
}

export async function cmdTmuxPeek(target: string, opts: TmuxPeekOpts = {}): Promise<void> {
  const hit = resolveTmuxTarget(target);
  if (!hit) {
    throw new Error(`cannot resolve target '${target}'`);
  }

  const { resolved, source } = hit;
  const lines = opts.lines ?? 30;
  const scroll = opts.history ? "-S -" : `-S -${lines}`;

  let out: string;
  try {
    out = await hostExec(`tmux capture-pane -pt '${resolved}' ${scroll} -J`);
  } catch (e: any) {
    throw new Error(`tmux capture-pane failed for '${resolved}' (from ${source}): ${e?.message || e}`);
  }

  console.log(`\x1b[90m▸ ${target} → ${resolved} [${source}]\x1b[0m`);
  console.log(out);
}
