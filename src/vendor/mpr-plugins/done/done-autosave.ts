import type { MawConfig } from "maw-js/config/types";
import { join } from "path";
import { pruneJsonlFile } from "../messages/retention";
import { doneDeps, type DoneDeps, type SessionInfo } from "./done-deps";
import type { DoneOpts } from "./impl";
import { resolveWindowEngine, retrospectiveCommandForEngine } from "./retrospective-command";

/** Signal parent oracle inbox that a worktree window is done (#81). */
export function signalParentInbox(
  windowName: string,
  sessionName: string,
  sessions: SessionInfo[],
  deps: DoneDeps = {},
): void {
  const d = doneDeps(deps);
  const from = process.env.CLAUDE_AGENT_NAME || windowName;
  const parentWindow = sessions.find(s => s.name === sessionName)?.windows[0]?.name;
  if (!parentWindow) return;
  const parentTarget = parentWindow.replace(/[^a-zA-Z0-9_-]/g, "");
  const inboxDir = d.inboxDir;
  const signal =
    JSON.stringify({ ts: d.now().toISOString(), from, type: "done", msg: `worktree ${windowName} completed`, thread: null }) + "\n";
  try {
    d.fs.mkdirSync(inboxDir, { recursive: true });
    const signalPath = join(inboxDir, `${parentTarget}.jsonl`);
    d.fs.appendFileSync(signalPath, signal);
    pruneJsonlFile(signalPath);
  } catch (e) {
    d.logger.error(`  \x1b[33m⚠\x1b[0m inbox signal failed: ${e}`);
  }
}

/**
 * Auto-save: send engine-appropriate retrospective command, git commit+push,
 * reunion + soul-sync (unless --force or dry-run).
 *
 * The retro form comes from the window's AUTHORITATIVE engine (fleet
 * runtime.engine → worktree .maw-engine), never pane_current_command (D3): a
 * codex worker's pane reports its bash/node wrapper, so pane-command inference
 * mis-sent /rrr to codex. Unresolved engine → skip rather than guess.
 */
export async function autoSave(
  windowName: string,
  sessionName: string,
  opts: DoneOpts,
  deps: DoneDeps = {},
): Promise<void> {
  const d = doneDeps(deps);
  const target = `${sessionName}:${windowName}`;

  let paneCwd = "";
  try {
    const paneInfo = await d.hostExec(`tmux display-message -t '${target}' -p '#{pane_current_path}'`);
    paneCwd = (paneInfo ?? "").trim();
  } catch { /* expected: pane may not exist */ }

  const engine = resolveWindowEngine(sessionName, windowName, paneCwd, {
    fleetEntries: d.loadFleetEntries(),
    readWorktreeEngineFile: d.readWorktreeEngineFile,
  });
  // Pass the live config so a custom engine key (e.g. a commands-map wrapper that
  // execs codex) is classified by its declared process family, not its name.
  let config: Partial<MawConfig> = {};
  try { config = loadConfig(); } catch { /* fall back to built-in classification */ }
  const retrospectiveCommand = retrospectiveCommandForEngine(engine, config);

  if (opts.dryRun) {
    if (retrospectiveCommand) {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would send ${retrospectiveCommand} to ${target} and wait 10s`);
    } else {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would skip retro (no retrospective command for this engine)`);
    }
    if (paneCwd) {
      d.logger.log(`  \x1b[36m⬡\x1b[0m [dry-run] would git add + commit + push in ${paneCwd}`);
    }
    // NOTE: kill-window and worktree/fleet-config removal are cmdDone's concern and
    // are previewed accurately there (against the real resolution), not claimed here.
    d.logger.log();
    return;
  }

  // Send a retrospective command aligned with the window's engine; skip when the
  // engine has no retrospective command or could not be resolved from MAW state.
  if (retrospectiveCommand) {
    d.logger.log(`  \x1b[36m⏳\x1b[0m sending ${retrospectiveCommand} to ${target}...`);
    try {
      await d.tmux.sendText(target, retrospectiveCommand);
      await d.sleep(10_000);
      d.logger.log(`  \x1b[32m✓\x1b[0m ${retrospectiveCommand} sent (waited 10s)`);
    } catch {
      d.logger.log(`  \x1b[33m⚠\x1b[0m could not send ${retrospectiveCommand} (agent may not be running)`);
    }
  } else {
    d.logger.log(`  \x1b[90m○\x1b[0m no retrospective command for this engine — skipping retro`);
  }

  // Git auto-save in pane's cwd
  if (paneCwd) {
    d.logger.log(`  \x1b[36m⏳\x1b[0m git auto-save in ${paneCwd}...`);
    try {
      await d.hostExec(`git -C '${paneCwd}' add -A`);
      try {
        await d.hostExec(`git -C '${paneCwd}' commit -m 'chore: auto-save before done'`);
        d.logger.log(`  \x1b[32m✓\x1b[0m committed changes`);
      } catch {
        d.logger.log(`  \x1b[90m○\x1b[0m nothing to commit`);
      }
      try {
        await d.hostExec(`git -C '${paneCwd}' push`);
        d.logger.log(`  \x1b[32m✓\x1b[0m pushed to remote`);
      } catch {
        d.logger.log(`  \x1b[33m⚠\x1b[0m push failed (no remote or auth issue)`);
      }
    } catch (e: any) {
      d.logger.log(`  \x1b[33m⚠\x1b[0m git auto-save failed: ${e.message || e}`);
    }
  }

  // Reunion + soul-sync
  await d.reunion(windowName);
  try { await d.soulSync(undefined, { cwd: paneCwd }); } catch { /* no peers configured */ }
}
