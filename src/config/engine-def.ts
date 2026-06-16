/**
 * Declarative agent engine definition (#1960).
 *
 * P1 is intentionally dormant: command rendering still flows through the
 * legacy command builder until the golden-master harness gates later phases.
 */
export interface EngineDef {
  /** Stable config key / CLI engine name (for example: claude, codex). */
  name: string;
  /** Executable or shell command prefix used to launch the engine. */
  cmd: string;
  /** Human label for UI surfaces such as swarm/team panes. */
  label?: string;
  /** Tmux pane_current_command basenames that identify this engine as live. */
  processNames?: string[];
  /** Arguments for a fresh launch form. Advisory until P2/P3 consumes it. */
  freshArgs?: string[];
  /** Resume form for engines that support session resurrection. */
  resume?: {
    flag: string;
    replaces?: string;
    quoteValue?: boolean;
  };
  /** Model selection surface for engines that support model routing. */
  model?: {
    flag?: string;
    env?: string;
    default?: string;
  };
  /** Capability gates consumed by future renderers. */
  capabilities?: string[];
  /** Preferred pane placement. Advisory until wake/team routing consumes it. */
  placement?: "split" | "window";
  /** Preferred isolation policy. Advisory until worktree routing consumes it. */
  isolation?: "none" | "worktree";
}
