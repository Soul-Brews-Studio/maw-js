import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const sleepDir = join(root, "src/vendor/mpr-plugins/sleep");
let sessions: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let fleet: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let detected: string | null = null;
let lifecycleCalls: unknown[] = [];
let savedTabs: string[] = [];

const sdkMock = {
  listSessions: async () => sessions,
  loadFleetCore: () => fleet,
  detectSession: async () => detected,
  saveTabOrder: async (session: string) => { savedTabs.push(session); },
  runSleepLifecycleHooks: async (ctx: unknown) => {
    lifecycleCalls.push(ctx);
    return { phase: "sleep", ran: 0, skipped: 0, failed: 0 };
  },
  mawMessageLogPath: () => "/tmp/maw-test/messages.jsonl",
  takeSnapshot: async () => undefined,
  tmux: {
    sendKeysLiteral: async () => undefined,
    sendKeys: async () => undefined,
    listWindows: async () => [],
    killWindow: async () => undefined,
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const { command, default: sleepHandler } = await import("../../src/vendor/mpr-plugins/sleep/index.ts");
const { cmdSleepOne } = await import("../../src/vendor/mpr-plugins/sleep/impl.ts");
const { resolveSleepTarget } = await import("../../src/vendor/mpr-plugins/sleep/resolve-target.ts");

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) specs.add(match[1] ?? match[2]);
  return [...specs];
}

beforeEach(() => {
  sessions = [];
  fleet = [];
  detected = null;
  lifecycleCalls = [];
  savedTabs = [];
});

describe("sleep plugin standalone boundary", () => {
  test("all sleep sources use SDK or local/platform imports only", () => {
    const imports = walkSources(sleepDir).flatMap((file) => importSpecs(readFileSync(file, "utf8")));
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/cli/")
      || spec === "maw-js/config"
      || spec.startsWith("maw-js/config/")
      || spec.startsWith("maw-js/plugin")
      || spec.includes("../../../core"),
    );

    expect(command).toMatchObject({ name: ["sleep"] });
    expect(forbidden).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("handler validates CLI/API arguments without tmux side effects", async () => {
    const cli = await sleepHandler({ source: "cli", args: [] } as any);
    expect(cli).toEqual({ ok: false, error: "usage: maw sleep <oracle> [window]  (see: maw kill for immediate removal, maw done for worktrees)" });

    const api = await sleepHandler({ source: "api", args: {} } as any);
    expect(api).toEqual({ ok: false, error: "oracle is required (usage: maw sleep <oracle> [window])" });

    const allDone = await sleepHandler({ source: "cli", args: ["--all-done"] } as any);
    expect(allDone.ok).toBe(true);
    expect(allDone.output).toContain("placeholder");
    expect(savedTabs).toEqual([]);
  });

  test("resolveSleepTarget preserves window, session, and detectSession tiers", async () => {
    const deps = {
      listSessions: async () => [
        { name: "mawjs", windows: [{ name: "codex-5" }] },
        { name: "29-arra", windows: [{ name: "main" }] },
      ],
      loadFleet: () => [{ name: "29-arra", windows: [{ name: "fleet-main" }] }],
      detectSession: async (oracle: string) => oracle === "neo" ? "neo-session" : null,
    };

    expect(await resolveSleepTarget("codex-5", undefined, deps)).toEqual({ session: "mawjs", window: "codex-5" });
    expect(await resolveSleepTarget("29-arra", undefined, deps)).toEqual({ session: "29-arra", window: "fleet-main" });
    expect(await resolveSleepTarget("neo", "chosen", deps)).toEqual({ session: "neo-session", window: "chosen" });
  });

  test("cmdSleepOne reports available windows when target cannot resolve", async () => {
    sessions = [{ name: "mawjs", windows: [{ name: "codex-1" }, { name: "codex-2" }] }];

    await expect(cmdSleepOne("missing")).rejects.toThrow("could not resolve sleep target: 'missing'");
    expect(savedTabs).toEqual([]);
    expect(lifecycleCalls).toEqual([]);
  });
});
