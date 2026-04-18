/**
 * maw learn — stub implementation (#521).
 *
 * Migration scaffold for Oracle skill /learn. Real flow (parallel Haiku
 * agents, ghq clone, symlink into ψ/learn/<owner>/<repo>/origin, date/time
 * folder layout, .origins manifest, hub file) is tracked as follow-up work.
 *
 * Until that lands, this stub:
 *   - Accepts <repo> + mode (default | fast | deep)
 *   - Returns a well-shaped stub message with the selected mode
 *   - Points users at the Oracle skill for actual learning runs
 *
 * The function is pure (no I/O, no process spawning) so it's safe to unit
 * test and safe to wire into the CLI ahead of the real impl.
 */

export type LearnMode = "default" | "fast" | "deep";

export interface LearnOptions {
  repo: string;
  mode: LearnMode;
}

/**
 * Return a stub message for `maw learn`. Will be replaced by the real
 * agent-spawning flow once the migration PR ships.
 */
export async function cmdLearn(repo: string, mode: LearnMode = "default"): Promise<string> {
  const agents = mode === "fast" ? 1 : mode === "deep" ? 5 : 3;

  const lines = [
    `learn: ${mode} mode on "${repo}" — not yet implemented in core plugin; use Oracle skill /learn for full behavior.`,
    `  planned: ${agents} parallel agent(s), write docs to ψ/learn/<owner>/<repo>/YYYY-MM-DD/HHMM_*.md`,
    `  track:   https://github.com/Soul-Brews-Studio/maw-js/issues/521`,
  ];
  const message = lines.join("\n");
  console.log(message);
  return message;
}

/**
 * Resolve mode from flag booleans. Exposed for tests and for future CLI
 * wiring that may accept a single `--mode` string alternative.
 */
export function resolveMode(fast: boolean, deep: boolean): LearnMode {
  if (fast && deep) throw new Error("--fast and --deep are mutually exclusive");
  if (fast) return "fast";
  if (deep) return "deep";
  return "default";
}
