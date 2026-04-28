/**
 * Tests for markAgentActive, checkIdleTriggers from src/core/runtime/triggers-idle.ts.
 * Uses mock.module to stub triggers-engine (fire, getTriggers, idleTimers, agentPrevState).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

const mockIdleTimers = new Map<string, number>();
const mockAgentPrevState = new Map<string, string>();
let mockTriggers: any[] = [];
let mockFireResults: { ok: boolean }[] = [{ ok: true }];
const fireCalls: any[] = [];

mock.module("../../src/core/runtime/triggers-engine", () => ({
  idleTimers: mockIdleTimers,
  agentPrevState: mockAgentPrevState,
  getTriggers: () => mockTriggers,
  fire: async (event: string, ctx: any) => {
    fireCalls.push({ event, ctx });
    return mockFireResults;
  },
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({}),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

const { markAgentActive, checkIdleTriggers } = await import(
  "../../src/core/runtime/triggers-idle"
);

beforeEach(() => {
  mockIdleTimers.clear();
  mockAgentPrevState.clear();
  mockTriggers = [];
  mockFireResults = [{ ok: true }];
  fireCalls.length = 0;
});

describe("markAgentActive", () => {
  it("sets idle timer to current time", () => {
    const before = Date.now();
    markAgentActive("neo");
    const after = Date.now();
    const ts = mockIdleTimers.get("neo")!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("sets agent prev state to busy", () => {
    markAgentActive("neo");
    expect(mockAgentPrevState.get("neo")).toBe("busy");
  });

  it("overwrites previous timer on repeat call", () => {
    markAgentActive("neo");
    const first = mockIdleTimers.get("neo")!;
    markAgentActive("neo");
    const second = mockIdleTimers.get("neo")!;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("tracks multiple agents independently", () => {
    markAgentActive("neo");
    markAgentActive("pulse");
    expect(mockIdleTimers.size).toBe(2);
    expect(mockAgentPrevState.size).toBe(2);
  });
});

describe("checkIdleTriggers", () => {
  it("returns empty when no agent-idle triggers configured", async () => {
    mockTriggers = [{ on: "session-start", timeout: 10 }];
    const result = await checkIdleTriggers();
    expect(result).toEqual([]);
  });

  it("returns empty when no agents are tracked", async () => {
    mockTriggers = [{ on: "agent-idle", timeout: 1 }];
    const result = await checkIdleTriggers();
    expect(result).toEqual([]);
  });

  it("fires trigger when agent is busy and idle timeout elapsed", async () => {
    mockTriggers = [{ on: "agent-idle", timeout: 1 }]; // 1 second
    mockIdleTimers.set("neo", Date.now() - 5000); // 5 sec ago — well past timeout
    mockAgentPrevState.set("neo", "busy");

    const result = await checkIdleTriggers();
    expect(result).toContain("neo");
    expect(fireCalls.length).toBe(1);
    expect(fireCalls[0].event).toBe("agent-idle");
    expect(fireCalls[0].ctx.agent).toBe("neo");
  });

  it("skips agent if prev state is not busy", async () => {
    mockTriggers = [{ on: "agent-idle", timeout: 0 }];
    mockIdleTimers.set("neo", Date.now() - 5000);
    mockAgentPrevState.set("neo", "idle"); // already idle

    const result = await checkIdleTriggers();
    expect(result).toEqual([]);
    expect(fireCalls.length).toBe(0);
  });

  it("skips agent when idle time is less than timeout", async () => {
    mockTriggers = [{ on: "agent-idle", timeout: 999 }]; // 999 seconds
    mockIdleTimers.set("neo", Date.now()); // just now
    mockAgentPrevState.set("neo", "busy");

    const result = await checkIdleTriggers();
    expect(result).toEqual([]);
  });

  it("transitions agent to idle after firing", async () => {
    mockTriggers = [{ on: "agent-idle", timeout: 1 }];
    mockIdleTimers.set("neo", Date.now() - 5000);
    mockAgentPrevState.set("neo", "busy");

    await checkIdleTriggers();
    expect(mockAgentPrevState.get("neo")).toBe("idle");
    expect(mockIdleTimers.has("neo")).toBe(false); // deleted after fire
  });

  it("does not transition if fire returns no ok results", async () => {
    mockFireResults = [{ ok: false }];
    mockTriggers = [{ on: "agent-idle", timeout: 1 }];
    mockIdleTimers.set("neo", Date.now() - 5000);
    mockAgentPrevState.set("neo", "busy");

    const result = await checkIdleTriggers();
    expect(result).toEqual([]);
    expect(mockAgentPrevState.get("neo")).toBe("busy"); // unchanged
    expect(mockIdleTimers.has("neo")).toBe(true); // not deleted
  });
});
