import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const pairPeersImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/internal/peers-impl.ts");
const sleepResolvePath = import.meta.resolve("../../src/vendor/mpr-plugins/sleep/resolve-target.ts");
const doneAutosavePath = import.meta.resolve("../../src/vendor/mpr-plugins/done/done-autosave.ts");
const doneWorktreePath = import.meta.resolve("../../src/vendor/mpr-plugins/done/done-worktree.ts");

let sessions: Array<{ name: string; windows: Array<{ index: number; name: string; active?: boolean }> }> = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let resolvedSleepTarget: { session: string; window: string } | null = { session: "alpha", window: "neo-oracle" };
let listWindowsResult: Array<{ name: string }> | Error = [];
let calls: string[] = [];
let fetchImpl: typeof fetch;
let now = 1_700_000_000_000;

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;
const realConsole = { log: console.log, error: console.error, warn: console.warn };

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ port: 4567, node: "local-node" }),
}));

mock.module(pairPeersImplPath, () => ({
  cmdAdd: async () => undefined,
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    calls.push(`host:${cmd}`);
    return hostExecImpl(cmd);
  },
  tmuxCmd: () => "tmux-test",
  saveTabOrder: async (session: string) => {
    calls.push(`save:${session}`);
  },
  takeSnapshot: async (trigger: string) => {
    calls.push(`snapshot:${trigger}`);
    throw new Error("snapshot unavailable");
  },
  FLEET_DIR: "/tmp/maw-coverage-next-vendor-b-fleet",
  tmux: {
    run: async (...args: string[]) => {
      calls.push(`run:${args.join(" ")}`);
      return "alpha\n";
    },
    sendKeysLiteral: async (target: string, ch: string) => {
      calls.push(`literal:${target}:${ch}`);
    },
    sendKeys: async (target: string, key: string) => {
      calls.push(`key:${target}:${key}`);
    },
    listWindows: async (session: string) => {
      calls.push(`list:${session}`);
      if (listWindowsResult instanceof Error) throw listWindowsResult;
      return listWindowsResult;
    },
    killWindow: async (target: string) => {
      calls.push(`kill:${target}`);
    },
  },
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (target: string, inputSessions: typeof sessions) => {
    const match = inputSessions.find((session) => session.name === target) ?? inputSessions[0];
    return match ? { kind: "exact", match } : { kind: "none", hints: [] };
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
  mkdir: async (dir: string) => {
    calls.push(`mkdir:${dir}`);
  },
  appendFile: async (file: string, line: string) => {
    calls.push(`append:${file}:${JSON.parse(line).window}`);
  },
}));
mock.module("os", () => ({ homedir: () => "/tmp/maw-coverage-next-vendor-b-home" }));
mock.module(sleepResolvePath, () => ({
  resolveSleepTarget: async () => resolvedSleepTarget,
}));

mock.module("maw-js/config/ghq-root", () => ({ getGhqRoot: () => "/tmp/maw-coverage-next-vendor-b-ghq" }));
mock.module(doneAutosavePath, () => ({
  signalParentInbox: async (windowName: string, sessionName: string) => {
    calls.push(`inbox:${sessionName}:${windowName}`);
  },
  autoSave: async (windowName: string, sessionName: string) => {
    calls.push(`autosave:${sessionName}:${windowName}`);
  },
}));
mock.module(doneWorktreePath, () => ({
  removeWorktreeViaConfig: async () => false,
  removeWorktreeByGhqScan: async () => false,
  removeFromFleetConfig: () => false,
}));

const { postHandshake } = await import("../../src/vendor/mpr-plugins/pair/handshake.ts?coverage-next-vendor-b-core");
const pairImpl = await import("../../src/vendor/mpr-plugins/pair/impl.ts?coverage-next-vendor-b-core");
const { cmdTag } = await import("../../src/vendor/mpr-plugins/tag/impl.ts?coverage-next-vendor-b-core");
const { cmdSleepOne } = await import("../../src/vendor/mpr-plugins/sleep/impl.ts?coverage-next-vendor-b-core");
const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl.ts?coverage-next-vendor-b-core");

beforeEach(() => {
  sessions = [];
  hostExecImpl = async () => "";
  resolvedSleepTarget = { session: "alpha", window: "neo-oracle" };
  listWindowsResult = [];
  calls = [];
  now = 1_700_000_000_000;
  Date.now = () => now;
  fetchImpl = (async () => Response.json({})) as typeof fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => fetchImpl(...args)) as typeof fetch;
  globalThis.setTimeout = ((handler: TimerHandler, _ms?: number, ...args: unknown[]) => {
    queueMicrotask(() => {
      if (typeof handler === "function") handler(...args as []);
    });
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
  console.log = (...args: unknown[]) => { calls.push(`log:${args.join(" ")}`); };
  console.error = (...args: unknown[]) => { calls.push(`error:${args.join(" ")}`); };
  console.warn = (...args: unknown[]) => { calls.push(`warn:${args.join(" ")}`); };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Date.now = realDateNow;
  console.log = realConsole.log;
  console.error = realConsole.error;
  console.warn = realConsole.warn;
});

describe("coverage-next vendor-b pair helpers", () => {
  test("postHandshake exercises the real timeout abort path", async () => {
    fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }) as typeof fetch;

    await expect(postHandshake("https://remote.example", "ABC123", { node: "local", url: "https://local" }, 1))
      .resolves.toEqual({ ok: false, error: "timeout", status: 0 });
  });

  test("pairGenerate tolerates invalid status JSON until the code expires", async () => {
    let fetchCount = 0;
    fetchImpl = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Response.json({ code: "ABC123", expiresAt: now + 1 });
      }
      now += 2;
      return {
        status: 200,
        ok: true,
        json: async () => { throw new Error("not json"); },
      } as Response;
    }) as typeof fetch;

    await expect(pairImpl.pairGenerate({ localUrl: "http://local.test", pollIntervalMs: 0 }))
      .resolves.toEqual({ ok: false, error: "pair code expired — no acceptor" });
    expect(fetchCount).toBe(2);
  });
});

describe("coverage-next vendor-b tag/sleep/done branches", () => {
  test("tag read mode treats unreadable pane options as empty metadata", async () => {
    sessions = [{ name: "alpha", windows: [{ index: 0, name: "oracle" }] }];
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("display-message")) return "oracle-title\n";
      throw new Error("show-options denied");
    };

    await cmdTag("alpha");

    expect(calls.some((entry) => entry.includes("title:") && entry.includes("oracle-title"))).toBe(true);
    expect(calls.some((entry) => entry.includes("meta:") && entry.includes("(none)"))).toBe(true);
  });

  test("sleep force-kills windows matched after dash trimming and ignores snapshot failures", async () => {
    listWindowsResult = [{ name: "neo-oracle---" }];

    await cmdSleepOne("neo");
    await Promise.resolve();

    expect(calls).toContain("kill:alpha:neo-oracle");
    expect(calls).toContain("snapshot:sleep");
  });

  test("done ignores rejected post-cleanup snapshots", async () => {
    sessions = [{ name: "alpha", windows: [{ index: 0, name: "lead", active: false }, { index: 1, name: "worker", active: true }] }];

    await cmdDone("worker", { force: true });
    await Promise.resolve();

    expect(calls).toContain("kill:alpha:worker");
    expect(calls).toContain("snapshot:done");
  });
});
