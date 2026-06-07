import { beforeEach, describe, expect, mock, test } from "bun:test";

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

let triggers: Trigger[] = [];
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

const engine = await import("../../src/core/runtime/triggers-engine.ts?runtime-triggers-extra");
const { fire, getTriggers, getTriggerHistory, idleTimers, agentPrevState } = engine;

function mockSpawn() {
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

beforeEach(() => {
  Bun.spawn = originalSpawn;
  triggers = [];
  savedConfigs = [];
  auditCalls = [];
  spawnQueue = [];
  idleTimers.clear();
  agentPrevState.clear();
  mockSpawn();
});

describe("runtime trigger engine", () => {
  test("getTriggers reads configured triggers and idle state maps are exported", () => {
    triggers = [{ on: "issue-close", action: "echo hi" }];
    idleTimers.set("oracle", 123);
    agentPrevState.set("oracle", "busy");

    expect(getTriggers()).toEqual(triggers);
    expect(idleTimers.get("oracle")).toBe(123);
    expect(agentPrevState.get("oracle")).toBe("busy");
  });

  test("fires matching triggers with template expansion, audit history, and once removal", async () => {
    triggers = [
      { name: "other", on: "pr-merge", action: "echo nope" },
      { name: "repo-mismatch", on: "issue-close", repo: "other/repo", action: "echo nope" },
      { name: "once", on: "issue-close", repo: "org/repo", action: "echo {event} {agent} {repo} {issue} {custom}", once: true },
    ];
    spawnQueue = [{ stdout: "done\n", code: 0 }];

    const results = await fire("issue-close" as any, {
      agent: "mawjs",
      repo: "org/repo",
      issue: "7",
      custom: "extra",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      action: "echo issue-close mawjs org/repo 7 extra",
      ok: true,
      output: "done",
    });
    expect(savedConfigs).toEqual([{ triggers: [triggers[0], triggers[1]] }]);
    expect(auditCalls[0]).toEqual(["trigger:fire", ["issue-close", triggers[2]!.action, "ok"], "ok"]);
    expect(getTriggerHistory()[0]).toMatchObject({ index: 2, result: { ok: true } });
  });

  test("agent-idle timeout skips until the configured idle duration has elapsed", async () => {
    const now = Date.now();
    triggers = [
      { name: "too-soon", on: "agent-idle", action: "echo soon", timeout: 60 },
      { name: "old-enough", on: "agent-idle", action: "echo old", timeout: 10 },
    ];
    idleTimers.set("alpha", now - 20_000);
    spawnQueue = [{ stdout: "old\n", code: 0 }];

    const results = await fire("agent-idle" as any, { agent: "alpha" });

    expect(results).toHaveLength(1);
    expect(results[0]?.trigger.name).toBe("old-enough");
    expect(results[0]?.ok).toBe(true);
  });

  test("records non-zero exits and thrown spawn errors without saving one-shot triggers", async () => {
    triggers = [
      { name: "bad-exit", on: "pr-merge", action: "exit 2", once: true },
      { name: "spawn-throw", on: "pr-merge", action: "explode" },
    ];
    spawnQueue = [{ stdout: "nope", code: 2 }, new Error("spawn missing")];

    const results = await fire("pr-merge" as any, { repo: "org/repo" });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false, error: "exit 2" });
    expect(results[1]).toMatchObject({ ok: false, error: "spawn missing" });
    expect(savedConfigs).toEqual([]);
    expect(auditCalls).toEqual([
      ["trigger:fire", ["pr-merge", "exit 2", "error"], "exit 2"],
      ["trigger:fire", ["pr-merge", "explode", "error"], "spawn missing"],
    ]);
  });

  test("missing trigger config and idle agents without activity still behave safely", async () => {
    triggers = undefined as unknown as Trigger[];
    expect(getTriggers()).toEqual([]);

    triggers = [{ name: "idle-no-clock", on: "agent-idle", action: "echo {agent}", timeout: 30 }];
    spawnQueue = [{ stdout: "ran" }];
    const results = await fire("agent-idle" as any, { agent: "never-seen" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, output: "ran" });
  });
});
