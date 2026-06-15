import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  serve,
  startServeMaintenance,
  startServeMemoryMaintenance,
  startServePtySweep,
} from "../../src/vendor-plugins/serve-maintenance/index.ts?plugin-serve-maintenance-standalone";

const root = join(import.meta.dir, "../..");

function makeTimerHarness() {
  const handlers: Array<() => void> = [];
  const intervals: number[] = [];
  let unrefCount = 0;
  return {
    handlers,
    intervals,
    get unrefCount() { return unrefCount; },
    setInterval(handler: () => void, timeout: number) {
      handlers.push(handler);
      intervals.push(timeout);
      return { unref: () => { unrefCount += 1; } };
    },
  };
}

describe("serve-maintenance plugin standalone boundary", () => {
  test("declares serve hook for PTY sweep and memory maintenance timers", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor-plugins/serve-maintenance/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.api).toBeUndefined();
    expect(manifest.module.exports).toContain("startServeMaintenance");
  });

  test("boundary drift is explicit for this core lifecycle plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-maintenance",
      pluginDir: "src/vendor-plugins/serve-maintenance",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/config$/,
        /^\.\.\/\.\.\/core\/transport\/pty$/,
        /^\.\.\/\.\.\/core\/message-queue$/,
        /^\.\.\/\.\.\/core\/request-reply$/,
        /^\.\.\/\.\.\/core\/agent-status$/,
        /^\.\.\/\.\.\/api\/config$/,
        /^\.\.\/\.\.\/lib\/pair-codes$/,
        /^\.\.\/\.\.\/api\/pair$/,
      ],
    });
  });

  test("PTY sweep timer preserves interval, unref, success logging, and error logging", async () => {
    const timer = makeTimerHarness();
    const info: string[] = [];
    const errors: unknown[][] = [];
    let fail = false;

    startServePtySweep({
      cfgInterval: ((key: string) => key === "ptySweep" ? 1234 : 0) as any,
      sweepOrphanPtySessions: async () => {
        if (fail) throw new Error("sweep boom");
        return { killed: ["maw-pty-old"], checked: 4 };
      },
      setInterval: timer.setInterval,
    }, {
      info: (line) => info.push(String(line)),
      error: (...args) => errors.push(args),
    });

    expect(timer.intervals).toEqual([1234]);
    expect(timer.unrefCount).toBe(1);

    timer.handlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(info).toEqual(["[pty-sweep] killed 1 orphan(s): maw-pty-old (checked 4)"]);

    fail = true;
    timer.handlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors[0][0]).toBe("[pty-sweep] failed:");
    expect(errors[0][1]).toBeInstanceOf(Error);
  });

  test("memory maintenance timer prunes all stores and swallows individual failures", () => {
    const timer = makeTimerHarness();
    const calls: string[] = [];

    startServeMemoryMaintenance({
      setInterval: timer.setInterval,
      messageQueue: { prune: () => { calls.push("message"); } },
      requestReplyStore: { prune: () => { calls.push("request"); throw new Error("ignore"); } },
      agentStatusStore: { prune: () => { calls.push("status"); } },
      prunePinAttempts: () => { calls.push("pin"); },
      prunePairCodes: () => { calls.push("codes"); throw new Error("ignore"); },
      prunePairResults: () => { calls.push("results"); },
    });

    expect(timer.intervals).toEqual([60_000]);
    expect(timer.unrefCount).toBe(1);
    timer.handlers[0]();
    expect(calls).toEqual(["message", "request", "status", "pin", "codes", "results"]);
  });

  test("serve hook starts both maintenance timers", () => {
    const timer = makeTimerHarness();
    const result = serve({}, {
      cfgInterval: (() => 300_000) as any,
      sweepOrphanPtySessions: async () => ({ killed: [], checked: 0 }),
      setInterval: timer.setInterval,
    });

    expect(result.ok).toBe(true);
    expect(result.timers).toHaveLength(2);
    expect(timer.intervals).toEqual([300_000, 60_000]);
    expect(timer.unrefCount).toBe(2);
  });

  test("startServeMaintenance mirrors serve hook behavior", () => {
    const timer = makeTimerHarness();
    const result = startServeMaintenance({
      cfgInterval: (() => 300_000) as any,
      sweepOrphanPtySessions: async () => ({ killed: [], checked: 0 }),
      setInterval: timer.setInterval,
    });

    expect(result.ok).toBe(true);
    expect(timer.intervals).toEqual([300_000, 60_000]);
  });
});
