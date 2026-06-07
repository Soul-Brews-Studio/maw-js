import { hostExec } from "maw-js/sdk";
import { tmux } from "maw-js/sdk";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { cmdReunion } from "./internal/reunion-impl";
import { cmdSoulSync } from "./internal/soul-sync-impl";
import type { DoneOpts } from "./impl";
import { mawDataPath } from "../../../core/xdg";

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };

/** Signal parent oracle inbox that a worktree window is done (#81). */
export async function signalParentInbox(
  windowName: string,
  sessionName: string,
  sessions: SessionInfo[],
): Promise<void> {
  const from = process.env.CLAUDE_AGENT_NAME || windowName;
  const parentWindow = sessions.find(s => s.name === sessionName)?.windows[0]?.name;
  if (!parentWindow) return;
  const parentTarget = parentWindow.replace(/[^a-zA-Z0-9_-]/g, "");
  const inboxDir = mawDataPath("inbox");
  const signal =
    JSON.stringify({ ts: new Date().toISOString(), from, type: "done", msg: `worktree ${windowName} completed`, thread: null }) + "\n";
  try {
    mkdirSync(inboxDir, { recursive: true });
    appendFileSync(join(inboxDir, `${parentTarget}.jsonl`), signal);
  } catch (e) {
    console.error(`  \x1b[33m⚠\x1b[0m inbox signal failed: ${e}`);
  }
}

/** Auto-save: send /rrr, git commit+push, reunion + soul-sync (unless --force or dry-run). */
export async function autoSave(
  windowName: string,
  sessionName: string,
  opts: DoneOpts,
): Promise<void> {
  const target = `${sessionName}:${windowName}`;

  let paneCwd = "";
  try {
    paneCwd = (await hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`)).trim();
  } catch { /* expected: pane may not exist */ }

  if (opts.dryRun) {
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send /rrr to ${target} and wait 10s`);
    if (paneCwd) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would kill window ${target}`);
    console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would remove worktree + fleet config`);
    console.log();
    return;
  }

  // Send /rrr to the agent for a session retrospective
  console.log(`  \x1b[36m⏳\x1b[0m sending /rrr to ${target}...`);
  try {
    await tmux.sendText(target, "/rrr");
    await new Promise(r => setTimeout(r, 10_000));
    console.log(`  \x1b[32m✓\x1b[0m /rrr sent (waited 10s)`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m could not send /rrr (agent may not be running)`);
  }

  // Git auto-save in pane's cwd
  if (paneCwd) {
    console.log(`  \x1b[36m⏳\x1b[0m git auto-save in ${paneCwd}...`);
    try {
      await hostExec(`git -C '${paneCwd}' add -A`);
      try {
        await hostExec(`git -C '${paneCwd}' commit -m 'chore: auto-save before done'`);
        console.log(`  \x1b[32m✓\x1b[0m committed changes`);
      } catch {
        console.log(`  \x1b[90m○\x1b[0m nothing to commit`);
      }
      try {
        await hostExec(`git -C '${paneCwd}' push`);
        console.log(`  \x1b[32m✓\x1b[0m pushed to remote`);
      } catch {
        console.log(`  \x1b[33m⚠\x1b[0m push failed (no remote or auth issue)`);
      }
    } catch (e: any) {
      console.log(`  \x1b[33m⚠\x1b[0m git auto-save failed: ${e.message || e}`);
    }
  }

  // Reunion + soul-sync
  await cmdReunion(windowName);
  try { await cmdSoulSync(undefined, { cwd: paneCwd }); } catch { /* no peers configured */ }
}
