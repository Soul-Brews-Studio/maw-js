import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

type TmuxWindow = { name: string };

let calls: string[] = [];
let detectedSession: string | null = "54-mawjs";
let windowResults: Array<TmuxWindow[] | Error> = [];
let sendLiteralShouldThrow = false;
let appendShouldThrow = false;
let snapshotShouldReject = false;

const realSetTimeout = globalThis.setTimeout;
const realConsole = {
  log: console.log,
  error: console.error,
};

const sdkMock = () => ({
  saveTabOrder: async (session: string) => {
    calls.push(`save:${session}`);
  },
  takeSnapshot: async (trigger: string) => {
    calls.push(`snapshot:${trigger}`);
    if (snapshotShouldReject) throw new Error("snapshot boom");
    return "/tmp/snapshot.json";
  },
  tmux: {
    listWindows: async (session: string) => {
      calls.push(`list:${session}`);
      const next = windowResults.shift();
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    sendKeysLiteral: async (target: string, ch: string) => {
      calls.push(`literal:${target}:${ch}`);
      if (sendLiteralShouldThrow) throw new Error("send literal boom");
    },
    sendKeys: async (target: string, key: string) => {
      calls.push(`key:${target}:${key}`);
    },
    killWindow: async (target: string) => {
      calls.push(`kill:${target}`);
    },
  },
});

mock.module("maw-js/sdk", sdkMock);
mock.module(join(import.meta.dir, "../../src/sdk"), sdkMock);
mock.module(join(import.meta.dir, "../../src/commands/shared/wake"), () => ({
  detectSession: async (oracle: string) => {
    calls.push(`detect:${oracle}`);
    return detectedSession;
  },
}));
mock.module(join(import.meta.dir, "../../src/plugin/lifecycle"), () => ({
  runSleepLifecycleHooks: async (ctx: { oracle: string; target: string; session: string; window: string }) => {
    calls.push(`hook:${ctx.oracle}:${ctx.target}:${ctx.session}:${ctx.window}`);
  },
}));
mock.module("os", () => ({
  homedir: () => "/tmp/maw-sleep-lib-next-home",
}));
mock.module("fs/promises", () => ({
  mkdir: async (dir: string) => {
    calls.push(`mkdir:${dir}`);
  },
  appendFile: async (file: string, line: string) => {
    calls.push(`append:${file}:${JSON.parse(line).window}`);
    if (appendShouldThrow) throw new Error("append boom");
  },
}));

const { cmdSleepOne } = await import("../../src/lib/sleep");

beforeEach(() => {
  calls = [];
  detectedSession = "54-mawjs";
  windowResults = [];
  sendLiteralShouldThrow = false;
  appendShouldThrow = false;
  snapshotShouldReject = false;

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

describe("src/lib/sleep next coverage", () => {
  test("throws when no running session is detected", async () => {
    detectedSession = null;

    await expect(cmdSleepOne("ghost")).rejects.toThrow("no running session found for 'ghost'");
    expect(calls).toEqual(["detect:ghost"]);
  });

  test("throws a clear error when the session windows cannot be listed", async () => {
    windowResults = [new Error("tmux list failed")];

    await expect(cmdSleepOne("neo")).rejects.toThrow("could not list windows for session '54-mawjs'");

    expect(calls).toContain("save:54-mawjs");
    expect(calls).toContain("hook:neo:neo:54-mawjs:neo-oracle");
    expect(calls.some((entry) => entry.startsWith("literal:"))).toBe(false);
  });

  test("uses fuzzy numbered windows, observes graceful exit, and appends the sleep log", async () => {
    windowResults = [
      [{ name: "neo-12-dev-" }],
      [],
    ];

    await cmdSleepOne("neo", "dev");

    expect(calls).toContain("literal:54-mawjs:neo-12-dev-:/");
    expect(calls).toContain("key:54-mawjs:neo-12-dev-:Enter");
    expect(calls).toContain("log:  \u001b[32m✓\u001b[0m neo-12-dev- exited gracefully");
    expect(calls).toContain("append:/tmp/maw-sleep-lib-next-home/.maw/maw-log.jsonl:neo-12-dev-");
    expect(calls).not.toContain("kill:54-mawjs:neo-12-dev-");
  });

  test("prints available windows before throwing when no exact or fuzzy target matches", async () => {
    windowResults = [
      [{ name: "neo-prod" }, { name: "other-oracle" }],
    ];

    await expect(cmdSleepOne("neo", "dev")).rejects.toThrow(
      "window 'neo-dev' not found in session '54-mawjs'",
    );

    expect(calls).toContain("error:\u001b[90mavailable:\u001b[0m neo-prod, other-oracle");
    expect(calls.some((entry) => entry.startsWith("literal:"))).toBe(false);
  });

  test("force-kills an exact target that still exists after the grace wait", async () => {
    windowResults = [
      [{ name: "neo-oracle" }],
      [{ name: "neo-oracle" }],
    ];

    await cmdSleepOne("neo");

    expect(calls).toContain("kill:54-mawjs:neo-oracle");
    expect(calls).toContain("log:  \u001b[33m!\u001b[0m force-killed neo-oracle (did not exit gracefully)");
  });

  test("continues when sending exit, post-wait listing, log append, and snapshot fail", async () => {
    sendLiteralShouldThrow = true;
    appendShouldThrow = true;
    snapshotShouldReject = true;
    windowResults = [
      [{ name: "neo-oracle" }],
      new Error("window already gone"),
    ];

    await cmdSleepOne("neo");
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContain("literal:54-mawjs:neo-oracle:/");
    expect(calls).toContain("wait:3000");
    expect(calls).toContain("log:  \u001b[32m✓\u001b[0m neo-oracle stopped");
    expect(calls.some((entry) => entry.includes("sleep log write failed"))).toBe(true);
    expect(calls).toContain("snapshot:sleep");
  });
});
