/**
 * Shared config mock for tests — re-exports all fields that
 * mock.module("../src/config") needs to provide so bun's global
 * mock pollution doesn't drop D/cfgInterval/cfgTimeout/cfgLimit
 * from unrelated test files.
 */
import type { MawConfig, MawIntervals, MawTimeouts, MawLimits } from "../../src/config";

const INTERVALS: Record<keyof MawIntervals, number> = {
  capture: 50, sessions: 5000, status: 3000, teams: 3000,
  preview: 2000, peerFetch: 10000, crashCheck: 30000,
};

const TIMEOUTS: Record<keyof MawTimeouts, number> = {
  http: 5000, health: 3000, ping: 5000, pty: 5000,
  workspace: 5000, shellInit: 3000, wakeRetry: 500, wakeVerify: 3000,
};

const LIMITS: Record<keyof MawLimits, number> = {
  feedMax: 500, feedDefault: 50, feedHistory: 50,
  logsMax: 500, logsDefault: 50, logsTruncate: 500,
  messageTruncate: 100, ptyCols: 500, ptyRows: 200,
};

export const TEST_D = {
  intervals: INTERVALS,
  timeouts: TIMEOUTS,
  limits: LIMITS,
  hmacWindowSeconds: 300,
} as const;

/** Build a complete config mock with typed helpers — no `as any` needed */
export function mockConfigModule(loadConfig: () => Partial<MawConfig>) {
  return {
    loadConfig,
    resetConfig: () => {},
    D: TEST_D,
    cfgInterval: (k: keyof MawIntervals) => INTERVALS[k],
    cfgTimeout: (k: keyof MawTimeouts) => TIMEOUTS[k],
    cfgLimit: (k: keyof MawLimits) => LIMITS[k],
    cfg: <K extends keyof MawConfig>(k: K) => loadConfig()[k],
  };
}
