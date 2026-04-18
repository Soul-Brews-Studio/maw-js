/**
 * maw incubate — stub implementation (#522).
 *
 * Migration scaffold for Oracle skill /incubate. Real flow (ghq clone/create,
 * origin symlink into ψ/incubate/<owner>/<repo>/origin, .origins manifest,
 * .claude/INCUBATED_BY breadcrumb, hub file, and the --flash / --contribute /
 * --status / --offload workflow modes) is tracked as follow-up work.
 *
 * Until that lands, this stub:
 *   - Accepts <repo> + mode (default | flash | contribute | status | offload)
 *   - Returns a well-shaped stub message with the selected mode
 *   - Points users at the Oracle skill for actual incubation runs
 *
 * The function is pure (no I/O, no process spawning) so it's safe to unit
 * test and safe to wire into the CLI ahead of the real impl.
 */

export type IncubateMode = "default" | "flash" | "contribute" | "status" | "offload";

export interface IncubateOptions {
  repo: string;
  mode: IncubateMode;
}

/**
 * Return a stub message for `maw incubate`. Will be replaced by the real
 * ghq + symlink + workflow flow once the migration PR ships.
 */
export async function cmdIncubate(repo: string, mode: IncubateMode = "default"): Promise<string> {
  const target = repo || "(none)";
  const lines = [
    `incubate: ${mode} mode on "${target}" — not yet implemented in core plugin; use Oracle skill /incubate for full behavior.`,
    `  planned: ghq clone/create → symlink ψ/incubate/<owner>/<repo>/origin → hub file + .origins manifest`,
    `  track:   https://github.com/Soul-Brews-Studio/maw-js/issues/522`,
  ];
  const message = lines.join("\n");
  console.log(message);
  return message;
}

/**
 * Resolve mode from flag booleans. Exposed for tests and for future CLI
 * wiring that may accept a single `--mode` string alternative.
 */
export function resolveMode(
  flash: boolean,
  contribute: boolean,
  status: boolean,
  offload: boolean,
): IncubateMode {
  const count = [flash, contribute, status, offload].filter(Boolean).length;
  if (count > 1) throw new Error("--flash, --contribute, --status, --offload are mutually exclusive");
  if (flash) return "flash";
  if (contribute) return "contribute";
  if (status) return "status";
  if (offload) return "offload";
  return "default";
}
