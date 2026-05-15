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

const DEFAULT_ACTIVE_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1500);

export function isDefaultActivePlugin(name: string): boolean {
  return DEFAULT_ACTIVE_SET.has(name);
}
