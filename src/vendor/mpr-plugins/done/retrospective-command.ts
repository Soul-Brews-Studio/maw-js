type RetrospectiveCommand = "/rrr" | "$rrr";

/** Engines that support the `$rrr` retrospective command (oh-my-codex wrapper). */
const DOLLAR_RRR_ENGINES = /\b(omx|oh-my-codex)\b/i;
/** Engines with no retrospective command — skip the retro step entirely. */
const NO_RETRO_ENGINES = /\b(codex|aider|opencode)\b/i;

/**
 * Choose the retrospective command for a pane's engine.
 *
 * Returns `null` to skip the retro entirely (engines that have no equivalent),
 * `$rrr` for the oh-my-codex wrapper, and `/rrr` for claude/unknown engines
 * (the historical default).
 */
export function inferRetrospectiveCommand(paneCurrentCommand: string): RetrospectiveCommand | null {
  const command = paneCurrentCommand || "";
  if (DOLLAR_RRR_ENGINES.test(command)) return "$rrr";
  if (NO_RETRO_ENGINES.test(command)) return null;
  return "/rrr";
}
