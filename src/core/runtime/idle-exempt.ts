/**
 * idle-exempt.ts — channel-aware exemption for agent-idle triggers (#2555).
 *
 * The trigger engine fires `agent-idle` actions (e.g. `maw sleep {agent}`)
 * when an agent has been idle past a trigger's timeout. Some idle agents are
 * idle *by design* — channel listeners (discord/telegram relays) sit idle
 * waiting for inbound messages and must not be auto-slept. A trigger opts into
 * this protection with `exempt: ["channel-listener"]`.
 *
 * The decision is a pure predicate (`isAgentExemptFromTrigger`) so it is
 * unit-testable without tmux, the feed, or a real channel config — the
 * channel-membership probe is injected and defaults to the real
 * `isChannelListener`.
 */

import type { TriggerConfig } from "../../config";
import { isChannelListener } from "../../commands/shared/channel-loader";

/** Exemption tag for agents subscribed to a channel plugin. */
export const CHANNEL_LISTENER_EXEMPT = "channel-listener";

/**
 * The opt-in default auto-sleep trigger (#2555).
 *
 * NOT auto-enabled — `getTriggers()` returns the operator's config verbatim.
 * Operators opt in by copying this into their `maw.config.json` `triggers`
 * array (or a future `maw fleet doctor --fix`). Sleeps non-channel agents
 * after 5 minutes idle; channel listeners are exempt.
 */
export const DEFAULT_AGENT_IDLE_SLEEP_TRIGGER: TriggerConfig = {
  on: "agent-idle",
  timeout: 300,
  action: "maw sleep {agent}",
  name: "auto-sleep idle agents (5m, channel-exempt)",
  exempt: [CHANNEL_LISTENER_EXEMPT],
};

/**
 * True when `agent` is exempt from `trigger` and the trigger should NOT fire.
 *
 * Only `"channel-listener"` is recognized today: when the trigger lists it in
 * `exempt` and the agent subscribes to a channel plugin, the trigger is
 * suppressed. Triggers without `exempt` always return false (fire normally).
 *
 * @param channelListener  injectable membership probe (defaults to the real
 *                         `isChannelListener`); tests pass a stub.
 */
export function isAgentExemptFromTrigger(
  trigger: Pick<TriggerConfig, "exempt">,
  agent: string,
  channelListener: (agent: string) => boolean = isChannelListener,
): boolean {
  if (!agent) return false;
  if (!trigger.exempt?.includes(CHANNEL_LISTENER_EXEMPT)) return false;
  return channelListener(agent);
}
