export const INFRA_CHANNEL_SUFFIXES = new Set([
  // Sessions created by `claude --channels` / bridge integrations. These are
  // infrastructure channel panes, not oracle home sessions; resolver paths
  // should not see every oracle's `*-discord` channel helper as a candidate.
  "discord",
  "telegram",
  "slack",
  "matrix",
  "signal",
  "whatsapp",
]);

function stripOracleSuffix(name: string): string {
  return name.replace(/-oracle$/i, "");
}

export function isInfrastructureChannelSessionName(sessionName: string, target: string): boolean {
  const targetBare = stripOracleSuffix(target.trim().toLowerCase());
  const name = sessionName.toLowerCase();

  // The oracle's own canonical repo/session shapes are still valid. For
  // example, `maw a discord` may legitimately resolve `23-discord-oracle`,
  // while `alice-oracle-discord` is a channel helper for Alice.
  if (targetBare && (name === targetBare || name === `${targetBare}-oracle` || name.endsWith(`-${targetBare}-oracle`))) {
    return false;
  }

  // `claude --channels` creates infrastructure tmux sessions like
  // `mawjs-oracle-discord` or `odin-discord`. These must be invisible to all
  // generic resolver paths, not only when the user typed the channel name, or
  // an absent oracle home session can be hijacked by its channel helper.
  return [...INFRA_CHANNEL_SUFFIXES].some((suffix) =>
    name.endsWith(`-${suffix}`) || name.includes(`-oracle-${suffix}`)
  );
}
