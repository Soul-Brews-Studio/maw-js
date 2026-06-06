/**
 * Decide whether a tmux pane's `pane_current_command` looks like an
 * agent runtime (claude / codex / thclaws / known generic launchers).
 *
 * Standalone (no maw-js imports) so consumers (broadcast, ssh-send)
 * can use it without dragging in tmux transport or config — keeping
 * test mocks for `maw-js/sdk` / `maw-js/config` independent of any
 * other module side effects (#1881 + #1906).
 *
 * Detection layers (any match → true):
 *  1. Hardcoded fleet engines (claude, codex, thclaws, thclaude).
 *     Substring-friendly because these names don't collide with benign
 *     commands.
 *  2. `node` REPL — agents launched via Bun/Node wrapper.
 *  3. Claude Code 2.1+ shows as a version string (e.g. `2.1.121`).
 *
 * Config-driven engine detection (looking up `commands.*` in maw config)
 * stays in ssh.ts's internal copy so it can use the cached config
 * accessor; that path is only needed for SSH-send today.
 */
export function isAgentCommand(cmd: string | null | undefined): boolean {
  const c = (cmd ?? "").trim();
  if (!c) return false;
  if (/claude|codex|thclaws|thclaude/i.test(c)) return true;
  if (/^node$/i.test(c)) return true;
  if (/^\d+\.\d+\.\d+$/.test(c)) return true;
  return false;
}
