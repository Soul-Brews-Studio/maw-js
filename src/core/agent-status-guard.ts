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

const MAW_PORT = process.env.MAW_PORT || "3456";

async function fetchRemoteStatus(oracle: string): Promise<{ status: AgentStatus } | null> {
  try {
    const res = await fetch(`http://localhost:${MAW_PORT}/api/status/${oracle}`);
    if (!res.ok) return null;
    const data = await res.json() as { status?: AgentStatus };
    return data?.status ? { status: data.status } : null;
  } catch {
    return null;
  }
}

/**
 * Check if a target oracle is busy.
 * In server context: reads local in-memory store.
 * In CLI context: queries the server API for live status.
 */
export async function checkBusyGuard(target: string): Promise<BusyGuardResult> {
  const oracle = extractOracleName(target);

  const entry = agentStatusStore.get(oracle);
  if (entry) {
    return { busy: entry.status === "busy", status: entry.status, oracle };
  }

  const remote = await fetchRemoteStatus(oracle);
  if (remote) {
    return { busy: remote.status === "busy", status: remote.status, oracle };
  }

  return { busy: false, status: "unknown", oracle };
}

/**
 * Queue a message for auto-delivery when the target becomes idle/ready.
 * In server context: enqueues locally. In CLI context: also POST to server
 * so DispatchEngine can auto-deliver.
 */
export async function queueForDispatch(opts: {
  from: string;
  to: string;
  target: string;
  message: string;
}) {
  const oracle = extractOracleName(opts.to);
  const msg = messageQueue.enqueue({
    from: opts.from,
    to: oracle,
    target: opts.target,
    message: opts.message,
  });

  if (!agentStatusStore.get(oracle)) {
    try {
      await fetch(`http://localhost:${MAW_PORT}/api/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: opts.from,
          to: opts.to,
          target: opts.target,
          message: opts.message,
        }),
      });
    } catch {}
  }

  return msg;
}
