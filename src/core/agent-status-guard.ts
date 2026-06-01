import { agentStatusStore, type AgentStatus } from "./agent-status";

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
