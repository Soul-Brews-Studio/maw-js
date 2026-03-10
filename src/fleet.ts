import { join } from "path";
import { readdirSync } from "fs";
import { ssh } from "./ssh";

interface FleetWindow {
  name: string;
  repo: string;
}

interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
}

const FLEET_DIR = join(import.meta.dir, "../fleet");
const GHQ_ROOT = "/home/nat/Code/github.com";
const COMMAND = "claude --continue --dangerously-skip-permissions";

function loadFleet(): FleetSession[] {
  const files = readdirSync(FLEET_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();

  return files.map(f => {
    const raw = require(join(FLEET_DIR, f));
    return raw as FleetSession;
  });
}

export async function cmdSleep() {
  const sessions = loadFleet();
  let killed = 0;

  for (const sess of sessions) {
    try {
      await ssh(`tmux kill-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1b[90m●\x1b[0m ${sess.name} — sleep`);
      killed++;
    } catch {
      // Session didn't exist
    }
  }

  console.log(`\n  ${killed} sessions put to sleep.\n`);
}

export async function cmdWakeAll(opts: { kill?: boolean } = {}) {
  const sessions = loadFleet();

  if (opts.kill) {
    console.log(`\n  \x1b[33mKilling existing sessions...\x1b[0m\n`);
    await cmdSleep();
  }

  const disabled = readdirSync(FLEET_DIR).filter(f => f.endsWith(".disabled")).length;
  console.log(`\n  \x1b[36mWaking fleet...\x1b[0m  (${sessions.length} sessions${disabled ? `, ${disabled} disabled` : ""})\n`);

  let sessCount = 0;
  let winCount = 0;

  for (const sess of sessions) {
    // Check if session already exists
    try {
      await ssh(`tmux has-session -t '${sess.name}' 2>/dev/null`);
      console.log(`  \x1b[33m●\x1b[0m ${sess.name} — already awake`);
      continue;
    } catch {
      // Good — doesn't exist yet
    }

    // Create session with first window
    const first = sess.windows[0];
    const firstPath = `${GHQ_ROOT}/${first.repo}`;
    await ssh(`tmux new-session -d -s '${sess.name}' -n '${first.name}' -c '${firstPath}'`);

    if (!sess.skip_command) {
      await ssh(`tmux send-keys -t '${sess.name}:${first.name}' '${COMMAND}' Enter`);
    }
    winCount++;

    // Add remaining windows
    for (let i = 1; i < sess.windows.length; i++) {
      const win = sess.windows[i];
      const winPath = `${GHQ_ROOT}/${win.repo}`;
      await ssh(`tmux new-window -t '${sess.name}' -n '${win.name}' -c '${winPath}'`);

      if (!sess.skip_command) {
        await ssh(`tmux send-keys -t '${sess.name}:${win.name}' '${COMMAND}' Enter`);
      }
      winCount++;
    }

    // Select first window
    await ssh(`tmux select-window -t '${sess.name}:1'`);
    sessCount++;
    console.log(`  \x1b[32m●\x1b[0m ${sess.name} — ${sess.windows.length} windows`);
  }

  console.log(`\n  \x1b[32m${sessCount} sessions, ${winCount} windows woke up.\x1b[0m\n`);
}
