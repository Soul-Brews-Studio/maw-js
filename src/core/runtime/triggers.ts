/**
 * Trigger Engine — barrel re-export.
 *
 * @see triggers-engine.ts — core fire/match logic, getTriggers, getTriggerHistory
 * @see triggers-cron.ts   — cron field parsing and wouldFireAt dry-run helper
 * @see triggers-idle.ts   — idle tracking, markAgentActive, checkIdleTriggers
 */

export type { TriggerContext, TriggerFireResult } from "./triggers-engine";
export { getTriggers, getTriggerHistory, fire, sweepStaleAgentState, STALE_AGENT_STATE_MS } from "./triggers-engine";
export { parseCronField, wouldFireAt } from "./triggers-cron";
export { markAgentActive, checkIdleTriggers } from "./triggers-idle";
