import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedPlugin } from "../src/plugin/types";
import { runLifecycleHooks, runServeLifecycleHooks, runSleepLifecycleHooks, runWakeLifecycleHooks } from "../src/plugin/lifecycle";

const tempDirs: string[] = [];

function makePlugin(
  name: string,
  opts: {
    weight?: number;
    disabled?: boolean;
    hook?: LoadedPlugin["manifest"]["hooks"];
    files?: Record<string, string>;
    entry?: string;
  } = {},
): LoadedPlugin {
  const dir = mkdtempSync(join(tmpdir(), `maw-life-${name}-`));
  tempDirs.push(dir);
  const entry = opts.entry ?? "index.ts";
  const files = opts.files ?? {
    [entry]: `export async function wake(ctx) { const fs = await import("fs"); fs.appendFileSync(process.env.MAW_LIFECYCLE_LOG, "${name}:" + ctx.oracle + ":" + ctx.session + "\\n"); }\n`,
  };
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return {
    dir,
    entryPath: join(dir, entry),
    wasmPath: "",
    kind: "ts",
    disabled: opts.disabled,
    manifest: {
      name,
      version: "1.0.0",
      sdk: "*",
      entry,
      weight: opts.weight,
      hooks: opts.hook ?? { wake: {} },
    },
  };
}

function makeLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-life-log-"));
  tempDirs.push(dir);
  const path = join(dir, "events.log");
  writeFileSync(path, "");
  process.env.MAW_LIFECYCLE_LOG = path;
  return path;
}

afterEach(() => {
  delete process.env.MAW_LIFECYCLE_LOG;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("plugin lifecycle hooks (#1576)", () => {
  test("wake hooks run enabled plugins in deterministic weight/name order", async () => {
    const log = makeLog();
    const plugins = [
      makePlugin("late-b", { weight: 20 }),
      makePlugin("early", { weight: 5 }),
      makePlugin("late-a", { weight: 20 }),
      makePlugin("disabled", { weight: 1, disabled: true }),
    ];

    const summary = await runWakeLifecycleHooks(
      { oracle: "mawjs", session: "47-mawjs", repoPath: "/repo", repoName: "mawjs-oracle" },
      () => plugins,
    );

    expect(summary).toEqual({ phase: "wake", ran: 3, skipped: 1, failed: 0 });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "early:mawjs:47-mawjs",
      "late-a:mawjs:47-mawjs",
      "late-b:mawjs:47-mawjs",
    ]);
  });

  test("hooks.wake.script + handler runs the declared module export", async () => {
    const log = makeLog();
    const plugin = makePlugin("scripted", {
      hook: { wake: { script: "setup.ts", handler: "onWake", ensures: ["storage:sqlite"] } },
      files: {
        "index.ts": "export function wake() { throw new Error('entry should not run') }\n",
        "setup.ts": `export function onWake(ctx) { const fs = require("fs"); fs.appendFileSync(process.env.MAW_LIFECYCLE_LOG, ctx.plugin.name + ":" + ctx.ensures.join(",") + "\\n"); }\n`,
      },
    });

    const summary = await runWakeLifecycleHooks(
      { oracle: "mawjs", session: "47-mawjs", repoPath: "/repo", repoName: "mawjs-oracle" },
      () => [plugin],
    );

    expect(summary).toEqual({ phase: "wake", ran: 1, skipped: 0, failed: 0 });
    expect(readFileSync(log, "utf8")).toBe("scripted:storage:sqlite\n");
  });

  test("sleep hooks receive resolved session/window context", async () => {
    const log = makeLog();
    const plugin = makePlugin("sleeper", {
      hook: { sleep: { script: "cleanup.ts", handler: "onSleep" } },
      files: {
        "index.ts": "export function sleep() { throw new Error('entry should not run') }\n",
        "cleanup.ts": `export function onSleep(ctx) { const fs = require("fs"); fs.appendFileSync(process.env.MAW_LIFECYCLE_LOG, [ctx.oracle, ctx.target, ctx.session, ctx.window, ctx.phase].join(":") + "\\n"); }\n`,
      },
    });

    const summary = await runSleepLifecycleHooks(
      { oracle: "mawjs", target: "mawjs", session: "54-mawjs", window: "mawjs-oracle" },
      () => [plugin],
    );

    expect(summary).toEqual({ phase: "sleep", ran: 1, skipped: 0, failed: 0 });
    expect(readFileSync(log, "utf8")).toBe("mawjs:mawjs:54-mawjs:mawjs-oracle:sleep\n");
  });

  test("serve hooks receive maw serve gateway context", async () => {
    const log = makeLog();
    const plugin = makePlugin("server", {
      hook: { serve: { script: "serve.ts", handler: "onServe" } },
      files: {
        "index.ts": "export function serve() { throw new Error('entry should not run') }\n",
        "serve.ts": `export function onServe(ctx) { const fs = require("fs"); fs.appendFileSync(process.env.MAW_LIFECYCLE_LOG, [ctx.phase, ctx.plugin.name, ctx.port, ctx.httpUrl, ctx.wsUrl, ctx.hostname].join("|") + "\\n"); }\n`,
      },
    });

    const summary = await runServeLifecycleHooks(
      { port: 4567, httpUrl: "http://localhost:4567", wsUrl: "ws://localhost:4567/ws", hostname: "127.0.0.1" },
      () => [plugin],
    );

    expect(summary).toEqual({ phase: "serve", ran: 1, skipped: 0, failed: 0 });
    expect(readFileSync(log, "utf8")).toBe("serve|server|4567|http://localhost:4567|ws://localhost:4567/ws|127.0.0.1\n");
  });

  test("best-effort failures continue, fail-fast failures throw clearly", async () => {
    const log = makeLog();
    const ok = makePlugin("ok", { weight: 2 });
    const bestEffort = makePlugin("best-effort", {
      weight: 1,
      hook: { wake: { policy: "best-effort" } },
      files: { "index.ts": `export function wake() { throw new Error("soft boom"); }\n` },
    });
    const summary = await runWakeLifecycleHooks(
      { oracle: "mawjs", session: "47-mawjs", repoPath: "/repo", repoName: "mawjs-oracle" },
      () => [ok, bestEffort],
    );

    expect(summary).toEqual({ phase: "wake", ran: 1, skipped: 0, failed: 1 });
    expect(readFileSync(log, "utf8")).toContain("ok:mawjs:47-mawjs");

    const failFast = makePlugin("fatal", {
      hook: { wake: { policy: "fail-fast" } },
      files: { "index.ts": `export function wake() { return { ok: false, error: "fatal boom" }; }\n` },
    });
    await expect(runLifecycleHooks("wake", {}, () => [failFast]))
      .rejects.toThrow(/plugin lifecycle wake failed for fatal: fatal boom/);
  });

  test("skips inapplicable hooks and records best-effort hardening failures", async () => {
    const noWake = makePlugin("no-wake", { hook: { sleep: {} } });
    const wasmNoScript = makePlugin("wasm-no-script");
    wasmNoScript.kind = "wasm";

    const skipped = await runLifecycleHooks("wake", {}, () => [noWake, wasmNoScript]);
    expect(skipped).toEqual({ phase: "wake", ran: 0, skipped: 1, failed: 0 });

    const noEntry = makePlugin("no-entry", { hook: { wake: { policy: "best-effort" } } });
    noEntry.entryPath = undefined;
    const missingScript = makePlugin("missing-script", { hook: { wake: { script: "missing.ts", policy: "best-effort" } } });
    const missingHandler = makePlugin("missing-handler", {
      hook: { wake: { script: "setup.ts", handler: "onWake", policy: "best-effort" } },
      files: { "index.ts": "", "setup.ts": `export const nope = 1;
` },
    });
    const okFalse = makePlugin("ok-false", {
      hook: { wake: { policy: "best-effort" } },
      files: { "index.ts": `export function wake() { return { ok: false }; }
` },
    });
    const primitiveThrow = makePlugin("primitive-throw", {
      hook: { wake: { policy: "best-effort" } },
      files: { "index.ts": `export function wake() { throw 'plain boom'; }
` },
    });

    const summary = await runLifecycleHooks("wake", {}, () => [noEntry, missingScript, missingHandler, okFalse, primitiveThrow]);
    expect(summary).toEqual({ phase: "wake", ran: 0, skipped: 0, failed: 5 });
  });

  test("rejects lifecycle scripts that escape the plugin directory", async () => {
    const parent = mkdtempSync(join(tmpdir(), "maw-life-escape-parent-"));
    tempDirs.push(parent);
    const dir = join(parent, "plugin");
    mkdirSync(dir);
    writeFileSync(join(dir, "index.ts"), "export function wake() {}\n");
    writeFileSync(join(parent, "outside.ts"), "export function wake() {}\n");
    const plugin: LoadedPlugin = {
      dir,
      entryPath: join(dir, "index.ts"),
      wasmPath: "",
      kind: "ts",
      manifest: {
        name: "escape",
        version: "1.0.0",
        sdk: "*",
        entry: "index.ts",
        hooks: { wake: { script: "../outside.ts", policy: "best-effort" } },
      },
    };

    const summary = await runLifecycleHooks("wake", {}, () => [plugin]);
    expect(summary).toEqual({ phase: "wake", ran: 0, skipped: 0, failed: 1 });
  });
});
