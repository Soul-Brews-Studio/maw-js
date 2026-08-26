import type { FleetEntry } from "../../../core/fleet/fleet-load-core";
import { isClaudeLikeEngine } from "../../../core/engine/is-claude-like";
import type { MawConfig } from "../../../config/types";

export type RetrospectiveCommand = "/rrr" | "$rrr";

/** Engines whose retrospective is the oh-my-codex `$rrr` form. In this fleet a
 *  codex worker registers `runtime.engine = "codex"` (see the live fleet records
 *  and `buildFleetWindowResumeCommand`'s `engine === "codex"` resume branch); it
 *  runs under the oh-my-codex wrapper, so its retro is `$rrr`, not `/rrr`. */
const DOLLAR_RRR_ENGINES = new Set(["codex", "omx", "oh-my-codex"]);
/** Engines with no retrospective equivalent — skip the retro step entirely. */
const NO_RETRO_ENGINES = new Set(["aider", "opencode"]);

/**
 * @deprecated Infers the retro form from `pane_current_command`, which is
 * unreliable: a codex worker's pane reports its `bash`/`node` wrapper rather
 * than `codex`, so it fell through to the `/rrr` default (D3). Prefer
 * {@link retrospectiveCommandForEngine} with the authoritative MAW-state engine
 * resolved by {@link resolveWindowEngine}. Retained only for the not-yet-migrated
 * `src/commands/shared/done.ts` consumer (de-dup is a separate change).
 */
export function inferRetrospectiveCommand(paneCurrentCommand: string): RetrospectiveCommand | null {
  const command = paneCurrentCommand || "";
  if (/\b(omx|oh-my-codex)\b/i.test(command)) return "$rrr";
  if (/\b(codex|aider|opencode)\b/i.test(command)) return null;
  return "/rrr";
}

/**
 * Choose the retrospective command from a window's AUTHORITATIVE engine name
 * (fleet `runtime.engine` / worktree `.maw-engine`), never the pane command.
 *
 * Returns `null` to skip the retro in two cases:
 *   - engines with no retrospective equivalent (aider/opencode), and
 *   - the fail-closed case where the engine could not be resolved from MAW
 *     state — we do not guess a form from an unreliable pane command.
 *
 * `$rrr` for codex/oh-my-codex, `/rrr` for claude-like and other engines (the
 * historical default). Claude-like detection routes through the engine registry
 * so aliases (`fast`, `claudeBeta`, …) inherit the `/rrr` form.
 */
export function retrospectiveCommandForEngine(
  engine: string | undefined,
  config: Partial<MawConfig> = {},
): RetrospectiveCommand | null {
  const name = engine?.trim().toLowerCase();
  if (!name) return null;
  if (DOLLAR_RRR_ENGINES.has(name)) return "$rrr";
  if (NO_RETRO_ENGINES.has(name)) return null;
  if (isClaudeLikeEngine(engine, config)) return "/rrr";
  return "/rrr";
}

export interface ResolveWindowEngineDeps {
  /** Fleet records to search for the window's captured `runtime.engine`. */
  fleetEntries: FleetEntry[];
  /** Reads a worktree's `.maw-engine` marker; may throw on an invalid marker. */
  readWorktreeEngineFile: (wtPath: string) => string | undefined;
}

/**
 * Resolve a window's engine from MAW state, most-authoritative first:
 *   1. the fleet record's captured `runtime.engine` for `session:window`, then
 *   2. the worktree `.maw-engine` marker at `paneCwd`.
 *
 * Returns `undefined` when neither source names an engine — the caller then
 * skips the retro rather than guessing from the (unreliable) pane command.
 */
export function resolveWindowEngine(
  sessionName: string,
  windowName: string,
  paneCwd: string,
  deps: ResolveWindowEngineDeps,
): string | undefined {
  for (const entry of deps.fleetEntries) {
    if (entry.session.name !== sessionName) continue;
    const win = entry.session.windows.find(w => w.name === windowName);
    const engine = win?.runtime?.engine?.trim();
    if (engine) return engine;
  }
  if (paneCwd) {
    try {
      const marker = deps.readWorktreeEngineFile(paneCwd);
      if (marker) return marker;
    } catch {
      // Invalid `.maw-engine` marker → treat as unresolved (fail-closed).
    }
  }
  return undefined;
}
