import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../core/paths";

/**
 * Phase 1.1 of #736 — pre-populate `config.agents` from fleet at loadConfig time.
 *
 * Background:
 *   Before this, `config.agents[name] = node` only got registered AFTER the first
 *   `maw wake <oracle>` call (src/commands/shared/wake-cmd.ts). That meant any
 *   fleet-known oracle was invisible to federation routing until a human had
 *   manually woken it once. `maw hey volt-colab-ml` would fail because
 *   `config.agents.volt-colab-ml` was unset, even though `fleet/101-volt-colab-ml.json`
 *   already declared the window. Same gap motivated `maw fleet --init-agents`
 *   (#215) — but that's a manual one-shot, and drift kept reopening.
 *
 * Fix:
 *   On every `loadConfig()` call, scan FLEET_DIR and inject `<window-name> → "local"`
 *   for every fleet window that isn't already in `config.agents`. Additive only —
 *   never overwrites a hand-tuned mapping. Pure in-memory: does NOT write to
 *   maw.config.json. Persistence stays the responsibility of `maw fleet
 *   --init-agents` and `maw wake`.
 *
 * Failure mode:
 *   If FLEET_DIR doesn't exist or any file is malformed, we swallow and return
 *   the input agents map unchanged. loadConfig() is too foundational to throw on
 *   a fleet glitch.
 */

interface FleetWindowLite {
  name?: string;
  repo?: string;
}

interface FleetSessionLite {
  name?: string;
  windows?: FleetWindowLite[];
}

/**
 * Merge fleet window names into the agents map.
 *
 * Pure function — no I/O, fully testable. Mirrors the local-fleet branch of
 * `cmdFleetInitAgents` so behaviour stays consistent between load-time auto-merge
 * and the explicit `maw fleet --init-agents` reconcile.
 */
export function mergeFleetIntoAgents(
  existing: Record<string, string>,
  fleet: FleetSessionLite[],
  localNode: string = "local",
): Record<string, string> {
  const proposed: Record<string, string> = { ...existing };
  for (const sess of fleet) {
    for (const w of sess?.windows || []) {
      if (!w?.name) continue;
      if (!(w.name in proposed)) proposed[w.name] = localNode;
    }
  }
  return proposed;
}

/**
 * Read every `*.json` (skipping `*.disabled`) from `dir` as a `FleetSessionLite`.
 * Returns `[]` when the directory is missing or unreadable, and silently skips
 * any file that fails to parse — a single corrupt fleet file shouldn't brick
 * config loading.
 */
export function readFleetDir(dir: string): FleetSessionLite[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"));
  } catch {
    return [];
  }
  const out: FleetSessionLite[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      out.push(JSON.parse(raw) as FleetSessionLite);
    } catch {
      // Skip malformed file — don't break config load over one bad fleet entry.
    }
  }
  return out;
}

/**
 * Convenience wrapper: read FLEET_DIR and merge into the supplied agents map.
 * `localNode` defaults to `"local"` (the convention used by `cmdFleetInitAgents`
 * and `wake-cmd.ts`'s auto-register path). Callers that know the canonical node
 * identity (e.g. `config.node`) can pass it through, but `"local"` keeps the
 * map self-referential which is what the rest of the codebase expects.
 */
export function loadFleetAgents(
  existing: Record<string, string> = {},
  localNode: string = "local",
  dir: string = FLEET_DIR,
): Record<string, string> {
  return mergeFleetIntoAgents(existing, readFleetDir(dir), localNode);
}
