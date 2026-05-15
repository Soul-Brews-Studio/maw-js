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

/**
 * #1523 follow-up: shellenv powers direnv/shell integration and should be part
 * of the standard operator surface. Stale profile-generated disabled lists can
 * hide it and make every shell action print an installed-but-disabled hint.
 */
export const DEFAULT_ACTIVE_PLUGINS_1523 = [
  "shellenv",
] as const;

export const DEFAULT_ACTIVE_PLUGINS_1523_MIGRATION = "defaultActivePlugins1523";

/**
 * #1524 follow-up: completions are baseline CLI ergonomics for the 80+ plugin
 * surface. Keep the generator callable under the standard profile and heal
 * stale profile-generated disabled lists that hide it.
 */
export const DEFAULT_ACTIVE_PLUGINS_1524 = [
  "completions",
] as const;

export const DEFAULT_ACTIVE_PLUGINS_1524_MIGRATION = "defaultActivePlugins1524";

/**
 * #1531 follow-up: Oracle workflow and federation-discovery verbs are linked
 * from day-to-day guidance. Stale profile-generated disabled lists should not
 * make these commands look missing.
 */
export const DEFAULT_ACTIVE_PLUGINS_1531 = [
  "learn",
  "find",
  "talk-to",
  "project",
  "workon",
  "cleanup",
] as const;

export const DEFAULT_ACTIVE_PLUGINS_1531_MIGRATION = "defaultActivePlugins1531";

const DEFAULT_ACTIVE_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1500);
const DEFAULT_ACTIVE_1514_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1514);
const DEFAULT_ACTIVE_1523_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1523);
const DEFAULT_ACTIVE_1524_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1524);
const DEFAULT_ACTIVE_1531_SET = new Set<string>(DEFAULT_ACTIVE_PLUGINS_1531);

export function isDefaultActivePlugin(name: string): boolean {
  return DEFAULT_ACTIVE_SET.has(name);
}

export function isDefaultActive1514Plugin(name: string): boolean {
  return DEFAULT_ACTIVE_1514_SET.has(name);
}

export function isDefaultActive1523Plugin(name: string): boolean {
  return DEFAULT_ACTIVE_1523_SET.has(name);
}

export function isDefaultActive1524Plugin(name: string): boolean {
  return DEFAULT_ACTIVE_1524_SET.has(name);
}

export function isDefaultActive1531Plugin(name: string): boolean {
  return DEFAULT_ACTIVE_1531_SET.has(name);
}
