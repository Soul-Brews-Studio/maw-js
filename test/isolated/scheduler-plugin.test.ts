import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { schedulerTick, serve } from "../../src/commands/plugins/scheduler/daemon";
import { runHook } from "../../src/commands/plugins/scheduler/hooks";
import { handleScheduler } from "../../src/commands/plugins/scheduler/index";
import {
  isDue,
  loadJobs,
  markDone,
  parseEvery,
  parseJobsYaml,
  readState,
  schedulerPaths,
  type SchedulerJob,
} from "../../src/commands/plugins/scheduler/jobs";
import manifest from "../../src/commands/plugins/scheduler/plugin.json";

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "maw-scheduler-plugin-"));
  return { root, paths: schedulerPaths(root, (...parts: string[]) => join(root, ".data", ...parts)) };
}

function writeJobs(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body.startsWith("\n") ? body.slice(1) : body);
}

const job: SchedulerJob = { name: "codex-monitor", every: "2m", target: "mawjs-oracle", prompt: "/codex-monitor" };

describe("scheduler plugin (#2818)", () => {
  test("plugin manifest exposes scheduler CLI and serve hook", () => {
    expect(manifest.cli.command).toBe("scheduler");
    expect(manifest.hooks.serve).toMatchObject({ script: "./daemon.ts", handler: "serve", policy: "fail-fast" });
  });

  test("parseEvery handles seconds, minutes, and hours", () => {
    expect(parseEvery("10s")).toBe(10_000);
    expect(parseEvery("2m")).toBe(120_000);
    expect(parseEvery("1h")).toBe(3_600_000);
    expect(() => parseEvery("1d")).toThrow("invalid every value");
  });

  test("parseJobsYaml reads hooks", () => {
    const parsed = parseJobsYaml(`
name: mawjs-m5
jobs:
  - name: codex-monitor
    every: 2m
    target: mawjs-oracle
    prompt: /codex-monitor
    hooks:
      before:
        - run: echo tick
      after:
        - log: done
        - publish: /tmp/scheduler-state.json
        - maw-hey:
            target: mawjs-oracle
            message: scheduler heartbeat complete
`);
    expect(parsed.jobs[0]).toMatchObject({ name: "codex-monitor", every: "2m", target: "mawjs-oracle", prompt: "/codex-monitor" });
    expect(parsed.jobs[0]?.hooks?.before).toEqual([{ run: "echo tick" }]);
    expect(parsed.jobs[0]?.hooks?.after?.[2]).toEqual({ "maw-hey": { target: "mawjs-oracle", message: "scheduler heartbeat complete" } });
  });

  test("isDue handles empty, recent, and expired state", () => {
    const { paths } = tempRoot();
    let state = readState(paths.stateFile);
    expect(isDue(job, state, 1_000)).toBe(true);
    markDone(paths.stateFile, job.name, 10_000);
    state = readState(paths.stateFile);
    expect(isDue(job, state, 30_000)).toBe(false);
    expect(isDue(job, state, 131_000)).toBe(true);
  });

  test("runHook supports run, publish, log, and maw-hey", async () => {
    const { root } = tempRoot();
    const publishFile = join(root, "out", "state.json");
    const events: string[] = [];
    await runHook({ run: "echo tick" }, job, { runShell: async (command) => { events.push(`run:${command}`); return 0; } });
    await runHook({ publish: publishFile }, job, { now: () => 42 });
    await runHook({ log: "done" }, job, { log: (message) => events.push(String(message)) });
    await runHook({ "maw-hey": { target: "mawjs-oracle", message: "ok" } }, job, { mawHey: async (target, message) => { events.push(`hey:${target}:${message}`); return 0; } });
    expect(events).toEqual(["run:echo tick", "[scheduler] done", "hey:mawjs-oracle:ok"]);
    expect(JSON.parse(readFileSync(publishFile, "utf8"))).toEqual({ ts: 42, job: "codex-monitor" });
  });

  test("maw-hey hooks cannot recursively target the scheduler itself", async () => {
    const warnings: string[] = [];
    const calls: string[] = [];
    await runHook({ "maw-hey": { target: "mawjs-scheduler", message: "loop" } }, job, {
      schedulerName: "mawjs-scheduler",
      warn: (message) => warnings.push(String(message)),
      mawHey: async (target, message) => { calls.push(`${target}:${message}`); return 0; },
    });
    expect(calls).toEqual([]);
    expect(warnings[0]).toContain("skipping recursive maw-hey hook");
  });

  test("job prompts reject shell metacharacters before dispatch", async () => {
    const { paths } = tempRoot();
    writeJobs(paths.jobsFile, `
jobs:
  - name: bad
    every: 10s
    target: mawjs-oracle
    prompt: /codex-monitor; rm -rf /
`);
    const result = await schedulerTick({ paths, error: () => {} });
    expect(result.errors[0]).toContain("unsafe scheduler prompt");
  });

  test("daemon tick dispatches due jobs and updates mawDataPath-backed state", async () => {
    const { paths } = tempRoot();
    writeJobs(paths.jobsFile, `
jobs:
  - name: codex-monitor
    every: 2m
    target: mawjs-oracle
    prompt: /codex-monitor
    hooks:
      after:
        - log: done
`);
    const events: string[] = [];
    const result = await schedulerTick({
      paths,
      now: () => 100,
      mawHey: async (target, message) => { events.push(`hey:${target}:${message}`); return 0; },
      log: (message) => events.push(String(message)),
    });
    expect(result).toEqual({ ran: ["codex-monitor"], skipped: [], disabled: false, errors: [] });
    expect(events).toEqual(["hey:mawjs-oracle:/codex-monitor", "[scheduler] done"]);
    expect(readState(paths.stateFile).jobs?.["codex-monitor"]?.lastRun).toBe(100);
  });

  test("serve hook starts an unref'd setInterval timer", () => {
    let intervalMs = 0;
    let unrefCalled = false;
    const result = serve({ source: "api" }, {
      tickMs: 1234,
      setInterval: (_handler, ms) => {
        intervalMs = ms;
        return { unref: () => { unrefCalled = true; } };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.timers).toHaveLength(1);
    expect(intervalMs).toBe(1234);
    expect(unrefCalled).toBe(true);
  });

  test("CLI status/list/run/start/stop dispatch through InvokeContext", async () => {
    const { paths } = tempRoot();
    writeJobs(paths.jobsFile, `
jobs:
  - name: codex-monitor
    every: 2m
    target: mawjs-oracle
    prompt: /codex-monitor
`);
    const list = await handleScheduler({ source: "cli", args: ["list"], flags: {}, matchedName: "scheduler" }, { paths });
    expect(list.ok).toBe(true);
    expect(list.output).toContain("codex-monitor");
    const calls: string[] = [];
    const run = await handleScheduler({ source: "cli", args: ["run", "codex-monitor"], flags: {}, matchedName: "scheduler" }, {
      paths,
      mawHey: async (target, message) => { calls.push(`${target}:${message}`); return 0; },
    });
    expect(run.ok).toBe(true);
    expect(calls).toEqual(["mawjs-oracle:/codex-monitor"]);
    expect((await handleScheduler({ source: "cli", args: ["stop"], flags: {}, matchedName: "scheduler" }, { paths })).output).toContain("disabled");
    expect(readState(paths.stateFile).enabled).toBe(false);
    expect((await handleScheduler({ source: "cli", args: ["start"], flags: {}, matchedName: "scheduler" }, { paths })).output).toContain("enabled");
  });

  test("CLI status with writer does not also return buffered duplicate output (#2822)", async () => {
    const { paths } = tempRoot();
    writeJobs(paths.jobsFile, `
jobs:
  - name: codex-monitor
    every: 2m
    target: mawjs-oracle
    prompt: /codex-monitor
`);
    const written: string[] = [];
    const result = await handleScheduler({
      source: "cli",
      args: ["status"],
      flags: {},
      matchedName: "scheduler",
      writer: (...args) => written.push(args.map(String).join(" ")),
    }, { paths });
    expect(result).toEqual({ ok: true, output: undefined });
    expect(written.filter((line) => line.includes("codex-monitor"))).toHaveLength(1);
    expect(written.join("\n").match(/codex-monitor/g)).toHaveLength(1);
  });

  test("loadJobs returns empty config when jobs.yaml is absent", () => {
    const { paths } = tempRoot();
    expect(loadJobs(paths.jobsFile)).toEqual({ jobs: [] });
  });
});
