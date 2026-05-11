import { join } from "path";
import { readdirSync } from "fs";
import { tmux } from "../../sdk";
// #1200 — call-time getter so test files that set MAW_CONFIG_DIR before
// dynamic-importing the production code see the sandbox path. The const
// FLEET_DIR in paths.ts is frozen at first module load (i.e., whichever
// test file imports paths.ts transitively first) and silently ignores
// later env-var changes.
import { getFleetDir } from "../../core/paths";

export interface FleetWindow {
  name: string;
  repo: string;
}

export interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
  /** Peer oracle names for soul-sync (flat, no hierarchy). */
  sync_peers?: string[];
  /** Project repos (org/repo) this oracle absorbs ψ/ from via `maw soul-sync --project`. */
  project_repos?: string[];
}

export interface FleetEntry {
  file: string;
  num: number;
  groupName: string;
  session: FleetSession;
}

export function loadFleet(): FleetSession[] {
  const files = readdirSync(getFleetDir())
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();
  // #1133 — skip malformed configs (missing name) so downstream
  // sess.name.replace(...) doesn't crash. Test fixtures from #484
  // were the trigger.
  return files
    .map(f => require(join(getFleetDir(), f)) as FleetSession)
    .filter(s => s && typeof s.name === "string");
}

export function loadFleetEntries(): FleetEntry[] {
  const files = readdirSync(getFleetDir())
    .filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))
    .sort();
  // #1175 — parity with loadFleet's #1133 filter: skip malformed configs
  // (missing `name`) so downstream `entry.session.name.replace(...)` doesn't
  // crash. Test fixtures from #484 (`{"writer":0}`, `{"a":1}`) were the
  // re-trigger surfaced via maw bud → bud-init.ts:87 + bud-wake.ts:64.
  return files.flatMap(f => {
    const raw = require(join(getFleetDir(), f));
    if (!raw || typeof raw.name !== "string") return [];
    const match = f.match(/^(\d+)-(.+)\.json$/);
    return [{
      file: f,
      num: match ? parseInt(match[1], 10) : 0,
      groupName: match ? match[2] : f.replace(".json", ""),
      session: raw as FleetSession,
    }];
  });
}

export async function getSessionNames(): Promise<string[]> {
  try {
    const out = await tmux.run("list-sessions", "-F", "#{session_name}");
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}
