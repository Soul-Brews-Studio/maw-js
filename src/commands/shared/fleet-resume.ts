import { join } from "path";
import { hostExec as ssh, tmux } from "../../sdk";
import { buildCommand } from "../../config";
import { getGhqRoot } from "../../config/ghq-root";
import type { FleetSession } from "./fleet-load";
import { pinWindowWide } from "./wake-pane-size";

type FleetResumeTmux = Pick<typeof tmux, "listSessions" | "listWindows" | "sendText" | "newWindow">;

export interface FleetResumeDeps {
  ssh: typeof ssh;
  tmux: FleetResumeTmux;
  buildCommand: typeof buildCommand;
  getGhqRoot: typeof getGhqRoot;
  pinWindowWide: typeof pinWindowWide;
  sleep: (ms: number) => Promise<void>;
  log: (...args: unknown[]) => void;
}

export function fleetResumeDeps(overrides: Partial<FleetResumeDeps> = {}): FleetResumeDeps {
  return {
    ssh,
    tmux,
    buildCommand,
    getGhqRoot,
    pinWindowWide,
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    log: console.log.bind(console) as (...args: unknown[]) => void,
    ...overrides,
  };
}

/** After fleet spawn, send /recap to oracles with active Pulse board items */
export async function resumeActiveItems(deps: Partial<FleetResumeDeps> = {}) {
  const io = fleetResumeDeps(deps);
  const repo = "laris-co/pulse-oracle";
  try {
    const issuesJson = await io.ssh(
      `gh issue list --repo ${repo} --state open --json number,title,labels --limit 50`
    );
    const issues: { number: number; title: string; labels: { name: string }[] }[] = JSON.parse(issuesJson || "[]");

    // Find issues assigned to oracles (label: oracle:<name>)
    const oracleItems = issues
      .filter(i => !i.labels.some(l => l.name === "daily-thread"))
      .map(i => ({
        ...i,
        oracle: i.labels.find(l => l.name.startsWith("oracle:"))?.name.replace("oracle:", ""),
      }))
      .filter(i => i.oracle);

    if (!oracleItems.length) {
      io.log("  \x1b[90mNo active board items to resume.\x1b[0m");
      return;
    }

    // Group by oracle, send /recap once per oracle
    const byOracle = new Map<string, typeof oracleItems>();
    for (const item of oracleItems) {
      const list = byOracle.get(item.oracle!) || [];
      list.push(item);
      byOracle.set(item.oracle!, list);
    }

    for (const [oracle, items] of byOracle) {
      const windowName = `${oracle}-oracle`;
      // Find which session has this window
      const sessions = await io.tmux.listSessions();
      for (const sess of sessions) {
        try {
          const windows = await io.tmux.listWindows(sess.name);
          const win = windows.find(w => w.name.toLowerCase() === windowName.toLowerCase());
          if (win) {
            const titles = items.map(i => `#${i.number}`).join(", ");
            // Wait for Claude to be ready (give it time to start)
            await io.sleep(2000);
            await io.tmux.sendText(`${sess.name}:${win.name}`, `/recap --deep — Resume after reboot. Active items: ${titles}`);
            io.log(`  \x1b[32m↻\x1b[0m ${oracle}: /recap sent (${titles})`);
            break;
          }
        } catch { /* window not found in this session */ }
      }
    }
  } catch (e) {
    io.log(`  \x1b[33mresume skipped:\x1b[0m ${e}`);
  }
}

/**
 * Scan disk for worktrees not registered in fleet configs.
 * For each running session, check if there are worktrees on disk
 * that don't have a corresponding tmux window, and spawn them.
 */
export async function respawnMissingWorktrees(sessions: FleetSession[], deps: Partial<FleetResumeDeps> = {}): Promise<number> {
  const io = fleetResumeDeps(deps);
  const reposRoot = join(io.getGhqRoot(), "github.com");
  let spawned = 0;

  for (const sess of sessions) {
    if (sess.skip_command) continue;

    // Find oracle main windows (pattern: {name}-oracle)
    const mainWindows = sess.windows.filter(w => w.name.endsWith("-oracle"));
    const registeredNames = new Set(sess.windows.map(w => w.name));

    for (const main of mainWindows) {
      const oracleName = main.name.replace(/-oracle$/, "");
      const repoPath = `${reposRoot}/${main.repo}`;
      const repoName = main.repo.split("/").pop()!;
      const parentDir = repoPath.replace(/\/[^/]+$/, "");

      let wtPaths: string[] = [];
      try {
        const raw = [
          await io.ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`),
          await io.ssh(`find ${repoPath}/agents -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true`),
        ].join("\n");
        wtPaths = [...new Set(raw.split("\n").filter(Boolean))];
      } catch { continue; }

      // Get running windows for this session
      let runningWindows: string[] = [];
      try {
        const windows = await io.tmux.listWindows(sess.name);
        runningWindows = windows.map(w => w.name);
      } catch { continue; }

      const usedNames = new Set([...registeredNames, ...runningWindows]);
      for (const wtPath of wtPaths) {
        const wtBase = wtPath.split("/").pop()!;
        const suffix = wtBase.includes(".wt-") ? wtBase.replace(`${repoName}.wt-`, "") : wtBase;
        const taskPart = suffix.replace(/^\d+-/, "");
        let windowName = `${oracleName}-${taskPart}`;
        if (usedNames.has(windowName)) {
          // If collision is with fleet config or running window, this worktree is already covered
          if (registeredNames.has(windowName) || runningWindows.includes(windowName)) continue;
          // True collision with another worktree in this loop → use numbered fallback
          windowName = `${oracleName}-${suffix}`;
        }
        const altName = `${oracleName}-${suffix}`; // old-style name with number

        // Skip if already registered in fleet config or running
        if (registeredNames.has(windowName) || registeredNames.has(altName)) continue;
        if (runningWindows.includes(windowName) || runningWindows.includes(altName)) continue;

        usedNames.add(windowName);
        try {
          await io.tmux.newWindow(sess.name, windowName, { cwd: wtPath });
          await io.pinWindowWide(`${sess.name}:${windowName}`);
          await io.sleep(300);
          await io.tmux.sendText(`${sess.name}:${windowName}`, io.buildCommand(windowName));
          io.log(`  \x1b[32m↻\x1b[0m ${windowName} (discovered on disk)`);
          spawned++;
        } catch { /* window creation failed */ }
      }
    }
  }

  return spawned;
}
