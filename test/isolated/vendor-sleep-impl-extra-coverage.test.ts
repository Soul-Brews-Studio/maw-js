import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let resolvedTarget: { session: string; window: string } | null = { session: "alpha", window: "neo-oracle" };
let sessions: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let listWindowsResult: Array<{ name: string }> | Error = [];
let calls: string[] = [];
let appendError: Error | null = null;

const realSetTimeout = globalThis.setTimeout;
const realConsole = { log: console.log, error: console.error };

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  saveTabOrder: async (session: string) => { calls.push(`save:${session}`); },
  takeSnapshot: async (trigger: string) => { calls.push(`snapshot:${trigger}`); },
  tmux: {
    sendKeysLiteral: async (target: string, ch: string) => { calls.push(`literal:${target}:${ch}`); },
    sendKeys: async (target: string, key: string) => { calls.push(`key:${target}:${key}`); },
    listWindows: async (session: string) => {
      calls.push(`list:${session}`);
      if (listWindowsResult instanceof Error) throw listWindowsResult;
      return listWindowsResult;
    },
    killWindow: async (target: string) => { calls.push(`kill:${target}`); },
  },
}));

mock.module("maw-js/commands/shared/wake", () => ({ detectSession: async () => "alpha" }));
mock.module("maw-js/commands/shared/fleet-load", () => ({ loadFleet: () => [] }));
mock.module("maw-js/plugin/lifecycle", () => ({
  runSleepLifecycleHooks: async (ctx: { oracle: string; session: string; window: string }) => {
    calls.push(`hook:${ctx.oracle}:${ctx.session}:${ctx.window}`);
  },
}));
mock.module("fs/promises", () => ({
  mkdir: async (dir: string) => { calls.push(`mkdir:${dir}`); },
  appendFile: async (file: string, line: string) => {
    calls.push(`append:${file}:${JSON.parse(line).window}`);
    if (appendError) throw appendError;
  },
}));
mock.module("os", () => ({ homedir: () => "/tmp/maw-vendor-sleep-home" }));
mock.module("../../src/vendor/mpr-plugins/sleep/resolve-target", () => ({
  resolveSleepTarget: async () => resolvedTarget,
}));

const { cmdSleepOne } = await import("../../src/vendor/mpr-plugins/sleep/impl.ts?vendor-sleep-impl-extra-coverage");

beforeEach(() => {
  resolvedTarget = { session: "alpha", window: "neo-oracle" };
  sessions = [];
  listWindowsResult = [];
  appendError = null;
  calls = [];
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    calls.push(`wait:${ms}`);
    if (typeof fn === "function") fn(...args as []);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  console.log = (...args: unknown[]) => { calls.push(`log:${args.join(" ")}`); };
  console.error = (...args: unknown[]) => { calls.push(`error:${args.join(" ")}`); };
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  console.log = realConsole.log;
  console.error = realConsole.error;
});

describe("vendor sleep impl extra coverage", () => {
  test("unresolved targets print capped available windows before throwing", async () => {
    resolvedTarget = null;
    sessions = [{ name: "alpha", windows: Array.from({ length: 12 }, (_, i) => ({ name: `w${i}` })) }];

    await expect(cmdSleepOne("ghost")).rejects.toThrow("could not resolve sleep target: 'ghost'");

    const available = calls.find((entry) => entry.startsWith("error:"));
    expect(available).toContain("alpha:w0");
    expect(available).toContain("(+2 more)");
  });

  test("logs graceful exit when the post-wait window list no longer contains the target", async () => {
    listWindowsResult = [{ name: "other" }];

    await cmdSleepOne("neo");

    expect(calls).toContain("save:alpha");
    expect(calls).toContain("hook:neo:alpha:neo-oracle");
    expect(calls).toContain("log:  \u001b[32m✓\u001b[0m neo-oracle exited gracefully");
    expect(calls).not.toContain("kill:alpha:neo-oracle");
  });

  test("logs stopped when listing windows fails after the grace wait", async () => {
    listWindowsResult = new Error("tmux gone");

    await cmdSleepOne("neo");

    expect(calls).toContain("log:  \u001b[32m✓\u001b[0m neo-oracle stopped");
  });

  test("continues sleeping when the best-effort sleep log write fails", async () => {
    appendError = new Error("readonly log");
    listWindowsResult = [{ name: "other" }];

    await cmdSleepOne("neo");

    expect(calls).toContain("error:\u001b[33m⚠\u001b[0m sleep log write failed: Error: readonly log");
    expect(calls).toContain("log:\u001b[32msleep\u001b[0m neo (neo-oracle)");
  });
});
