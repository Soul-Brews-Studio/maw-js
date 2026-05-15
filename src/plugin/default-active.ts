/**
 * Default-active plugin policy.
 *
 * These plugins are operator-facing primitives that should stay active under
 * the normal/standard profile. #1500 found existing configs where an older
 * profile run left them in `disabledPlugins`, making installed commands look
 * removed. Keep the list small and explicit: niche/heavy plugins should remain
 * opt-in.
 */
export const DEFAULT_ACTIVE_PLUGINS_1500 = [
  "team",
  "fleet",
  "panes",
  "peers",
  "pair",
  "tmux",
  "kill",
  "plugin",
  "doctor",
  "inbox",
] as const;

export const DEFAULT_ACTIVE_PLUGINS_1500_MIGRATION = "defaultActivePlugins1500";

/**
 * #1514 follow-up: `maw split` is a help-prominent top-level verb in
 * src/cli/top-aliases.ts, so stale profile-generated disabled lists must not
 * keep it hidden after #1500 already ran.
 */
export const DEFAULT_ACTIVE_PLUGINS_1514 = [
  "split",
] as const;

export const DEFAULT_ACTIVE_PLUGINS_1514_MIGRATION = "defaultActivePlugins1514";

const DEFAULT_ACTIVE_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1500);
const DEFAULT_ACTIVE_1514_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1514);

export function isDefaultActivePlugin(name: string): boolean {
  return DEFAULT_ACTIVE_SET.has(name);
}

export function isDefaultActive1514Plugin(name: string): boolean {
  return DEFAULT_ACTIVE_1514_SET.has(name);
}
