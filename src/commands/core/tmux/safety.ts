/**
 * Safety gates for maw tmux verbs that mutate pane state (send, kill).
 * Centralized so `send` and `kill` share the same refuse/confirm logic.
 *
 * Three classes of gate:
 *   1. Destructive-command patterns (deny-list, `--allow-destructive` bypass)
 *   2. Claude-running pane refusal (never inject into a live claude process)
 *   3. Fleet-session kill refusal (never kill live oracles — Bug F class)
 */

/**
 * Patterns that likely destroy data or state if sent blindly. Matched as
 * substring (case-sensitive since command contents matter). Refuse unless
 * --allow-destructive is explicitly passed.
 */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: "rm — removes files" },
  { pattern: /\bsudo\b/, reason: "sudo — elevated privileges" },
  { pattern: />\s*\S/, reason: "> redirect — overwrites" },
  { pattern: />>\s*\S/, reason: ">> redirect — appends (possibly to wrong place)" },
  { pattern: /;\s*\S/, reason: "; command chain — multiple commands" },
  { pattern: /&&\s*\S/, reason: "&& chain — conditional execution" },
  { pattern: /\|\s*\S/, reason: "| pipe — composition (review carefully)" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard — discards changes" },
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: "git push --force — rewrites history" },
  { pattern: /\bgit\s+clean\s+-[fF]/, reason: "git clean -f — removes untracked files" },
  { pattern: /\bgh\s+.*\bdelete\b/, reason: "gh delete — removes GitHub resource" },
  { pattern: /\bkill\s+-9\b/, reason: "kill -9 — force-terminate process" },
  { pattern: /\bdrop\s+table\b/i, reason: "DROP TABLE — removes database table" },
];

export interface DestructiveCheck {
  destructive: boolean;
  reasons: string[];
}

/**
 * Scan a command string for destructive patterns. Returns all matched
 * reasons (not just the first) so error messages can surface every concern.
 */
export function checkDestructive(cmd: string): DestructiveCheck {
  const reasons: string[] = [];
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(cmd)) reasons.push(reason);
  }
  return { destructive: reasons.length > 0, reasons };
}

/**
 * Given a tmux pane's current command, decide if injecting keys would
 * collide with a Claude Code process. Matching `claude` as substring
 * is intentional — subprocess names can be `claude`, `bun ... claude`,
 * version strings like `2.1.111`, etc. Anything containing `claude`
 * refuses by default.
 *
 * Also refuses for `2.1.111`-style claude-version prefixes that some
 * bun+claude wrappers display as the pane command.
 */
export function isClaudeLikePane(paneCurrentCommand: string | undefined): boolean {
  if (!paneCurrentCommand) return false;
  const cmd = paneCurrentCommand.toLowerCase();
  if (cmd.includes("claude")) return true;
  // Claude Code with bun often shows as "2.1.111" etc. — version-y pattern.
  if (/^\d+\.\d+\.\d+$/.test(cmd.trim())) return true;
  return false;
}

/**
 * Foot-gun refusal message (#1303) — shared between `maw split` and
 * `maw pane split` so a single grep finds every refusal site. Both verbs
 * implicitly carve $TMUX_PANE when called without an explicit anchor;
 * when the caller is Claude Code, that carves the live AI pane.
 *
 * Returns the full error body (caller throws). Includes the offending
 * pane id and current-command so the user can verify the heuristic
 * matched the pane they expected.
 */
export function callerPaneCarveRefusal(panePane: string, callerCmd: string | undefined): string {
  return (
    `refusing to carve caller's pane: would slice the claude-like pane '${panePane}' (running '${callerCmd ?? "?"}').\n` +
    `  use \`maw shell <name>\` for a non-carve interactive shell (#1304)\n` +
    `  use \`maw bg <name> "<cmd>"\` for a non-carve background command (#1304)\n` +
    `  use \`--from <oracle>\` (or \`-t <pane>\` for \`maw pane split\`) to carve a different pane intentionally`
  );
}

/**
 * Fleet session protection (shared with kill). A session whose name
 * matches a known fleet stem OR ends in `-view` must never be killed
 * without --force.
 */
export function isFleetOrViewSession(sessionName: string, fleetSessions: ReadonlySet<string>): boolean {
  if (fleetSessions.has(sessionName)) return true;
  if (sessionName === "maw-view") return true;
  if (/-view$/.test(sessionName)) return true;
  return false;
}
