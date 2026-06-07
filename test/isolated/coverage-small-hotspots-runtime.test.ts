import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const configPath = import.meta.resolve("../../src/config.ts");
const auditPath = import.meta.resolve("../../src/core/fleet/audit.ts");

type Trigger = {
  name?: string;
  on: string;
  action: string;
  repo?: string;
  timeout?: number;
  once?: boolean;
};

let triggers: Trigger[] | undefined = [];
let savedConfigs: unknown[] = [];
let auditCalls: unknown[][] = [];

mock.module(configPath, () => ({
  loadConfig: () => ({ triggers }),
  saveConfig: (cfg: unknown) => savedConfigs.push(cfg),
}));

mock.module(auditPath, () => ({
  logAudit: (...args: unknown[]) => auditCalls.push(args),
}));

const originalSpawn = Bun.spawn;
let spawnQueue: Array<{ stdout?: string; code?: number } | Error> = [];
const triggerEngine = await import("../../src/core/runtime/triggers-engine.ts?coverage-small-hotspots-runtime");
const { fire, getTriggerHistory, idleTimers } = triggerEngine;

function installSpawnMock() {
  Bun.spawn = ((cmd: string[]) => {
    const next = spawnQueue.shift() ?? { stdout: "", code: 0 };
    if (next instanceof Error) throw next;
    return {
      stdout: new Response(next.stdout ?? "").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(next.code ?? 0),
      cmd,
    } as any;
  }) as typeof Bun.spawn;
}

const tempDirs: string[] = [];
const originalHotReload = process.env.MAW_HOT_RELOAD;
const originalWarnStateFile = process.env.MAW_WARN_STATE_FILE;
const fsModule = require("fs") as typeof import("fs") & {
  watch: (dir: string, opts: unknown, cb: (event: string, filename: string | null) => void) => { close: () => void };
  existsSync: (path: string) => boolean;
};
const originalWatch = fsModule.watch;
const originalExistsSync = fsModule.existsSync;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  Bun.spawn = originalSpawn;
  triggers = [];
  savedConfigs = [];
  auditCalls = [];
  spawnQueue = [];
  idleTimers.clear();
  installSpawnMock();
  delete process.env.MAW_HOT_RELOAD;
  delete process.env.MAW_WARN_STATE_FILE;
  fsModule.watch = originalWatch;
  fsModule.existsSync = originalExistsSync;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
  if (originalHotReload === undefined) delete process.env.MAW_HOT_RELOAD;
  else process.env.MAW_HOT_RELOAD = originalHotReload;
  if (originalWarnStateFile === undefined) delete process.env.MAW_WARN_STATE_FILE;
  else process.env.MAW_WARN_STATE_FILE = originalWarnStateFile;
  fsModule.watch = originalWatch;
  fsModule.existsSync = originalExistsSync;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("small hotspot runtime coverage", () => {
  test("trigger engine skips filters, expands literal placeholders, records success and errors", async () => {
    const now = Date.now();
    triggers = [
      { name: "other-event", on: "pr-merge", action: "echo nope" },
      { name: "repo-skip", on: "issue-close", repo: "other/repo", action: "echo nope" },
      { name: "idle-wait", on: "agent-idle", action: "echo nope", timeout: 60 },
      { name: "literal", on: "issue-close", action: "echo {agent} {weird.key}", once: true },
      { name: "bad", on: "issue-close", action: "exit 9" },
    ];
    idleTimers.set("alpha", now - 1_000);
    spawnQueue = [{ stdout: "ok\n", code: 0 }, { stdout: "", code: 9 }];

    const results = await fire("issue-close" as any, {
      agent: "alpha",
      repo: "org/repo",
      "weird.key": "literal-value",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ action: "echo alpha literal-value", ok: true, output: "ok" });
    expect(results[1]).toMatchObject({ action: "exit 9", ok: false, error: "exit 9" });
    expect(savedConfigs).toEqual([{ triggers: [triggers[0], triggers[1], triggers[2], triggers[4]] }]);
    expect(auditCalls).toEqual([
      ["trigger:fire", ["issue-close", "echo {agent} {weird.key}", "ok"], "ok"],
      ["trigger:fire", ["issue-close", "exit 9", "error"], "exit 9"],
    ]);
    expect(getTriggerHistory().map((entry) => entry.result.ok).sort()).toEqual([false, true]);

    triggers = [{ name: "idle-wait", on: "agent-idle", action: "echo nope", timeout: 60 }];
    idleTimers.set("alpha", now - 1_000);
    expect(await fire("agent-idle" as any, { agent: "alpha" })).toEqual([]);
  });

  test("registry helper warning path tolerates corrupt state and rewrites it", async () => {
    const dir = tempDir("maw-registry-helper-hotspot-");
    const missing = join(dir, "missing-plugin");
    const stateFile = join(dir, "state", "warnings.json");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(stateFile, "{not-json");
    process.env.MAW_WARN_STATE_FILE = stateFile;

    const fresh = await import(`../../src/plugin/registry-helpers.ts?coverage-small-hotspots-${Date.now()}-${Math.random()}`);
    const writes: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(fresh.isDevModeInstall(missing)).toBe(false);
      fresh.warnLegacyOnce(1);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(writes.join("")).toContain("1 legacy plugin loaded without artifact hash");
    expect(JSON.parse(readFileSync(stateFile, "utf8"))["legacy-plugin-warning"].lastShownMs).toBeGreaterThan(0);
  });

  test("watcher reports native watch failures as a safe no-op closer", () => {
    const { watchUserPlugins } = require("../../src/plugins/40_watcher.ts") as typeof import("../../src/plugins/40_watcher");
    fsModule.existsSync = () => true;
    fsModule.watch = () => { throw new Error("watch denied"); };
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const close = watchUserPlugins("/tmp/plugins", () => { throw new Error("unused"); }, 1);
      close();
    } finally {
      spy.mockRestore();
    }

    expect(errors.join("\n")).toContain("[plugin:watch] cannot watch /tmp/plugins: watch denied");
  });
});
