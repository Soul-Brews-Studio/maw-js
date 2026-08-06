import { cfgInterval as defaultCfgInterval } from "../../config";
import { sweepOrphanPtySessions as defaultSweepOrphanPtySessions } from "../../core/transport/pty";
import { messageQueue as defaultMessageQueue } from "../../core/message-queue";
import { requestReplyStore as defaultRequestReplyStore } from "../../core/request-reply";
import { agentStatusStore as defaultAgentStatusStore } from "../../core/agent-status";
import { prunePinAttempts as defaultPrunePinAttempts } from "../../api/config";
import { prunePairCodes as defaultPrunePairCodes } from "../../lib/pair-codes";
import { prunePairResults as defaultPrunePairResults } from "../../api/pair";

type ServeLog = {
  info?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type TimerHandle = { unref?: () => void };
type SetIntervalFn = (handler: () => void, timeout: number) => TimerHandle;

type Prunable = { prune: () => unknown };

type ServeMaintenanceContext = {
  log?: ServeLog;
};

type ServeMaintenanceDeps = {
  cfgInterval: typeof defaultCfgInterval;
  sweepOrphanPtySessions: typeof defaultSweepOrphanPtySessions;
  messageQueue: Prunable;
  requestReplyStore: Prunable;
  agentStatusStore: Prunable;
  prunePinAttempts: () => unknown;
  prunePairCodes: () => unknown;
  prunePairResults: () => unknown;
  setInterval: SetIntervalFn;
};

const defaultDeps: ServeMaintenanceDeps = {
  cfgInterval: defaultCfgInterval,
  sweepOrphanPtySessions: defaultSweepOrphanPtySessions,
  messageQueue: defaultMessageQueue,
  requestReplyStore: defaultRequestReplyStore,
  agentStatusStore: defaultAgentStatusStore,
  prunePinAttempts: defaultPrunePinAttempts,
  prunePairCodes: defaultPrunePairCodes,
  prunePairResults: defaultPrunePairResults,
  setInterval: (handler, timeout) => setInterval(handler, timeout) as TimerHandle,
};

function unrefTimer(timer: TimerHandle): void {
  timer.unref?.();
}

export function startServePtySweep(
  deps: Partial<ServeMaintenanceDeps> = {},
  log?: ServeLog,
): TimerHandle {
  const d = { ...defaultDeps, ...deps };
  const timer = d.setInterval(() => {
    d.sweepOrphanPtySessions()
      .then(({ killed, checked }) => {
        if (killed.length > 0) {
          log?.info?.(`[pty-sweep] killed ${killed.length} orphan(s): ${killed.join(", ")} (checked ${checked})`);
        }
      })
      .catch((err) => log?.error?.("[pty-sweep] failed:", err));
  }, d.cfgInterval("ptySweep"));
  unrefTimer(timer);
  return timer;
}

export function startServeMemoryMaintenance(
  deps: Partial<ServeMaintenanceDeps> = {},
): TimerHandle {
  const d = { ...defaultDeps, ...deps };
  const timer = d.setInterval(() => {
    try { d.messageQueue.prune(); } catch { /* best effort */ }
    try { d.requestReplyStore.prune(); } catch { /* best effort */ }
    try { d.agentStatusStore.prune(); } catch { /* best effort */ }
    try { d.prunePinAttempts(); } catch { /* best effort */ }
    try { d.prunePairCodes(); } catch { /* best effort */ }
    try { d.prunePairResults(); } catch { /* best effort */ }
  }, 60_000);
  unrefTimer(timer);
  return timer;
}

export function startServeMaintenance(
  deps: Partial<ServeMaintenanceDeps> = {},
  log?: ServeLog,
): { ok: true; timers: TimerHandle[] } {
  return {
    ok: true,
    timers: [
      startServePtySweep(deps, log),
      startServeMemoryMaintenance(deps),
    ],
  };
}

export function serve(
  ctx: ServeMaintenanceContext = {},
  deps?: Partial<ServeMaintenanceDeps>,
): { ok: true; timers: TimerHandle[] } {
  return startServeMaintenance(deps, ctx.log);
}

export default serve;
