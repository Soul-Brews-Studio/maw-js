import { agentStatusStore, type AgentStatus } from "./agent-status";
import { messageQueue } from "./message-queue";

/**
 * Extract bare oracle name from a query/target string.
 * "neo" → "neo", "neo-oracle" → "neo", "08-mawjs:neo-oracle" → "neo"
 */
export function extractOracleName(target: string): string {
  const parts = target.split(":");
  const last = parts.at(-1) || target;
  return last.replace(/-oracle$/i, "").trim();
}

export interface BusyGuardResult {
  busy: boolean;
  status: AgentStatus | "unknown";
  oracle: string;
}

/**
 * Check if a target oracle is busy. Returns busy=true only when we have
 * positive evidence (feed-event-derived status) that the agent is actively
 * working. Unknown agents (no status data) are allowed through.
 */
export function checkBusyGuard(target: string): BusyGuardResult {
  const oracle = extractOracleName(target);
  const entry = agentStatusStore.get(oracle);
  if (!entry) return { busy: false, status: "unknown", oracle };
  return { busy: entry.status === "busy", status: entry.status, oracle };
}

/**
 * Queue a message for auto-delivery when the target becomes idle/ready.
 * Called by the busy guard when it blocks a message from being injected.
 */
export function queueForDispatch(opts: {
  from: string;
  to: string;
  target: string;
  message: string;
}) {
  const oracle = extractOracleName(opts.to);
  return messageQueue.enqueue({
    from: opts.from,
    to: oracle,
    target: opts.target,
    message: opts.message,
  });
}
