/**
 * #1576 — `maw sleep` should execute plugin sleep lifecycle hooks before it
 * starts sending /exit into the target pane.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LoadedPlugin } from "../../src/plugin/types";

let calls: string[] = [];
let hookShouldThrow = false;
let plugins: LoadedPlugin[] = [];
const tempDirs: string[] = [];

const session = { name: "54-mawjs", windows: [{ name: "mawjs-oracle" }] };

const sdkMock = () => ({
  listSessions: async () => {
    calls.push("listSessions");
    return [session];
  },
  saveTabOrder: async (name: string) => {
    calls.push(`save:${name}`);
  },
  takeSnapshot: async (trigger: string) => {
    calls.push(`snapshot:${trigger}`);
    return "/tmp/snapshot.json";
  },
  tmux: {
    listWindows: async (name: string) => {
      calls.push(`listWindows:${name}`);
      return session.windows;
    },
    sendKeysLiteral: async (target: string, ch: string) => {
      calls.push(`literal:${target}:${ch}`);
    },
    sendKeys: async (target: string, key: string) => {
      calls.push(`key:${target}:${key}`);
    },
    killWindow: async (target: string) => {
      calls.push(`kill:${target}`);
    },
  },
});

const wakeMock = () => ({
  detectSession: async (target: string) => {
    calls.push(`detect:${target}`);
    return session.name;
  },
});

const fleetMock = () => ({
  loadFleet: () => {
    calls.push("loadFleet");
    return [session];
  },
});

mock.module("maw-js/sdk", sdkMock);
mock.module("maw-js/commands/shared/wake", wakeMock);
mock.module("maw-js/commands/shared/fleet-load", fleetMock);

mock.module(join(import.meta.dir, "../../src/sdk"), sdkMock);
mock.module(join(import.meta.dir, "../../src/commands/shared/wake"), wakeMock);
mock.module(join(import.meta.dir, "../../src/plugin/registry"), () => ({
  discoverPackages: () => plugins,
}));

function makeSleepPlugin(): LoadedPlugin {
  const dir = mkdtempSync(join(tmpdir(), "maw-sleep-life-"));
  tempDirs.push(dir);
  const entry = "index.ts";
  writeFileSync(join(dir, entry), `
    export function sleep(ctx) {
      globalThis.__mawSleepLifecycleCalls.push("hook:" + ctx.oracle + ":" + ctx.target + ":" + ctx.session + ":" + ctx.window);
      if (globalThis.__mawSleepLifecycleThrow) throw new Error("fatal sleep hook");
    }
  `);
  return {
    dir,
    entryPath: join(dir, entry),
    wasmPath: "",
    kind: "ts",
    manifest: {
      name: "sleep-ledger",
      version: "1.0.0",
      sdk: "*",
      entry,
      hooks: { sleep: { policy: "fail-fast" } },
    },
  };
}

const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  calls = [];
  hookShouldThrow = false;
  (globalThis as unknown as { __mawSleepLifecycleCalls: string[] }).__mawSleepLifecycleCalls = calls;
  (globalThis as unknown as { __mawSleepLifecycleThrow: boolean }).__mawSleepLifecycleThrow = hookShouldThrow;
  plugins = [makeSleepPlugin()];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    calls.push(`wait:${ms}`);
    if (typeof fn === "function") fn(...args as []);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  delete (globalThis as unknown as { __mawSleepLifecycleCalls?: string[] }).__mawSleepLifecycleCalls;
  delete (globalThis as unknown as { __mawSleepLifecycleThrow?: boolean }).__mawSleepLifecycleThrow;
  plugins = [];
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const { cmdSleepOne: cmdPluginSleepOne } = await import("../../src/vendor/mpr-plugins/sleep/impl");
const { cmdSleepOne: cmdLibSleepOne } = await import("../../src/lib/sleep");

describe("sleep lifecycle hooks (#1576)", () => {
  test("plugin sleep command runs hook after target resolution and before /exit", async () => {
    await cmdPluginSleepOne("mawjs");

    const hookIndex = calls.indexOf("hook:mawjs:mawjs:54-mawjs:mawjs-oracle");
    const exitIndex = calls.findIndex((entry) => entry.startsWith("literal:54-mawjs:mawjs-oracle:/"));
    expect(hookIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(hookIndex).toBeLessThan(exitIndex);
    expect(calls).toContain("snapshot:sleep");
  });

  test("fail-fast sleep hooks abort before sending /exit", async () => {
    hookShouldThrow = true;
    (globalThis as unknown as { __mawSleepLifecycleThrow: boolean }).__mawSleepLifecycleThrow = true;

    await expect(cmdPluginSleepOne("mawjs")).rejects.toThrow(/plugin lifecycle sleep failed for sleep-ledger: fatal sleep hook/);

    expect(calls).toContain("hook:mawjs:mawjs:54-mawjs:mawjs-oracle");
    expect(calls.some((entry) => entry.startsWith("literal:"))).toBe(false);
    expect(calls.some((entry) => entry.startsWith("kill:"))).toBe(false);
    expect(calls).not.toContain("snapshot:sleep");
  });

  test("shared lib sleep path used by /api/sleep also runs hooks before /exit", async () => {
    await cmdLibSleepOne("mawjs");

    const hookIndex = calls.indexOf("hook:mawjs:mawjs:54-mawjs:mawjs-oracle");
    const exitIndex = calls.findIndex((entry) => entry.startsWith("literal:54-mawjs:mawjs-oracle:/"));
    expect(hookIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(hookIndex).toBeLessThan(exitIndex);
  });
});
