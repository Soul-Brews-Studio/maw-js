import { hostExec } from "maw-js/sdk";
import { tmux } from "maw-js/sdk";
import { loadFleetEntries } from "maw-js/sdk";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { cmdReunion } from "./internal/reunion-impl";
import { cmdSoulSync } from "./internal/soul-sync-impl";
import type { DoneOpts } from "./impl";
import { mawDataPath } from "../../../core/xdg";
import { readWorktreeEngineFile } from "../../../commands/shared/wake-session";
import { resolveWindowEngine, retrospectiveCommandForEngine } from "./retrospective-command";

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

/** Auto-save: send engine-appropriate retrospective command, git commit+push, reunion + soul-sync (unless --force or dry-run). */
export async function autoSave(
  windowName: string,
  sessionName: string,
  opts: DoneOpts,
): Promise<void> {
  const target = `${sessionName}:${windowName}`;

  let paneCwd = "";
  try {
    const paneInfo = await hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`);
    paneCwd = (paneInfo ?? "").trim();
  } catch { /* expected: pane may not exist */ }

  // Pick the retro form from the window's AUTHORITATIVE engine (fleet
  // runtime.engine → worktree .maw-engine), never pane_current_command: a codex
  // worker's pane reports its bash/node wrapper, so the old pane-command inference
  // mis-sent /rrr to codex (D3). Unresolved engine → skip rather than guess.
  const engine = resolveWindowEngine(sessionName, windowName, paneCwd, {
    fleetEntries: loadFleetEntries(),
    readWorktreeEngineFile,
  });
  const retrospectiveCommand = retrospectiveCommandForEngine(engine);

  if (opts.dryRun) {
    if (retrospectiveCommand) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send ${retrospectiveCommand} to ${target} and wait 10s`);
    } else {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would skip retro (no retrospective command for this engine)`);
    }
    if (paneCwd) {
      console.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    // NOTE: kill-window and worktree/fleet-config removal are cmdDone's concern and
    // are previewed accurately there (against the real resolution), not claimed here.
    console.log();
    return;
  }

  // Send a retrospective command aligned with the panel's engine; skip when the
  // engine has no retrospective command (codex/aider/opencode).
  if (retrospectiveCommand) {
    console.log(`  \x1b[36m⏳\x1b[0m sending ${retrospectiveCommand} to ${target}...`);
    try {
      await tmux.sendText(target, retrospectiveCommand);
      await new Promise(r => setTimeout(r, 10_000));
      console.log(`  \x1b[32m✓\x1b[0m ${retrospectiveCommand} sent (waited 10s)`);
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m could not send ${retrospectiveCommand} (agent may not be running)`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m no retrospective command for this engine — skipping retro`);
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
