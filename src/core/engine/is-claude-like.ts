import type { MawConfig } from "../../config/types";
import { ENGINE_SEED, isClaudeLikeCommand, resolveEngine } from "../../config/engine-registry";

/**
 * Shared claude-like engine detector (#2099).
 *
 * Consolidates the duplicated `engine?.toLowerCase() === "claude"` checks that
 * lived in wake-cmd, wake-inbox-drain, and friends. Those copies only matched
 * the literal name "claude" and silently misclassified aliases — a config
 * `engines.fast = { cmd: "claude --model opus" }` or a raw `claudeBeta`
 * command was treated as non-claude, so claude-only behavior (the `-p` prompt
 * form, inbox drain) was skipped.
 *
 * Resolving the name through the engine registry first means aliases inherit
 * the detection: an engine counts as claude-like when its launch command looks
 * claude-like, or it declares the claude-only `system-prompt-file` capability.
 */

/** Capability only claude-like engines declare (the `-p`/system-prompt form). */
const CLAUDE_LIKE_CAPABILITY = "system-prompt-file";

export function isClaudeLikeEngine(
  engine: string | undefined,
  config: Partial<MawConfig> = {},
): boolean {
  const name = engine?.trim();
  if (!name) return false;

  let def;
  try {
    def = resolveEngine(name, config);
  } catch {
    // Read-only classification can fall back to the seed registry when config is
    // unavailable/empty. Launch resolution remains strict in resolveEngine().
    def = ENGINE_SEED[name.toLowerCase()];
  }
  if (isClaudeLikeCommand(def?.cmd ?? "")) return true;
  return def?.capabilities?.includes(CLAUDE_LIKE_CAPABILITY) ?? false;
}
