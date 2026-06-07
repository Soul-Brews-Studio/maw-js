import { beforeEach, describe, expect, mock, test } from "bun:test";

const runImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/run/impl");
const sendImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send/impl");
const sendTextImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send-text/impl");
const sendEnterImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send-enter/impl");
const takeImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/take/impl");
const locateImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/locate/impl");
const restartImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/restart/impl");
const viewImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/view/impl");
const cleanupZombiesPath = import.meta.resolve("../../src/vendor/mpr-plugins/cleanup/internal/team-cleanup-zombies");
const cleanupPrunePath = import.meta.resolve("../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles");
const learnImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/learn/impl");
const projectImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/project/impl");

type Call = { name: string; args: unknown[] };
let calls: Call[] = [];
let failures: Record<string, Error | undefined> = {};

function reset() {
  calls = [];
  failures = {};
}

function record(name: string, ...args: unknown[]) {
  calls.push({ name, args });
  console.log(`${name}:${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(":")}`);
  const failure = failures[name];
  if (failure) throw failure;
}

mock.module(runImplPath, () => ({
  parseRunArgs: (args: string[]) => ({ target: args[0] ?? "", text: args.slice(1).join(" ") }),
  cmdRun: async (opts: unknown) => record("run", opts),
}));

mock.module(sendImplPath, () => ({
  parseSendArgs: (args: string[]) => ({ target: args[0] ?? "", text: args.slice(1).join(" ") }),
  cmdSend: async (opts: unknown) => record("send", opts),
}));

mock.module(sendTextImplPath, () => ({
  parseSendTextArgs: (args: string[]) => ({ target: args[0] ?? "", text: args.slice(1).join(" ") }),
  cmdSendText: async (opts: unknown) => record("send-text", opts),
}));

mock.module(sendEnterImplPath, () => ({
  parseSendEnterArgs: (args: string[]) => ({ target: args[0] ?? "", count: Number(args[1] ?? 1) }),
  cmdSendEnter: async (opts: unknown) => record("send-enter", opts),
}));

mock.module(takeImplPath, () => ({
  cmdTake: async (...args: unknown[]) => record("take", ...args),
}));

mock.module(locateImplPath, () => ({
  cmdLocate: async (...args: unknown[]) => record("locate", ...args),
}));

mock.module(restartImplPath, () => ({
  cmdRestart: async (opts: unknown) => record("restart", opts),
}));

mock.module(viewImplPath, () => ({
  cmdView: async (...args: unknown[]) => record("view", ...args),
}));

mock.module(cleanupZombiesPath, () => ({
  cmdCleanupZombies: async (opts: unknown) => record("cleanup-zombies", opts),
}));

mock.module(cleanupPrunePath, () => ({
  cmdPruneStale: async (opts: unknown) => record("cleanup-prune", opts),
}));

mock.module(learnImplPath, () => ({
  cmdLearn: async (...args: unknown[]) => {
    record("learn", ...args);
    return "learn-result";
  },
}));

mock.module(projectImplPath, () => ({
  helpText: () => "project-help",
  stubLearn: async (url: string) => {
    record("project-learn", url);
    return "project-learn-result";
  },
  stubIncubate: async (url: string) => {
    record("project-incubate", url);
    return "project-incubate-result";
  },
  stubFind: async (query: string) => {
    record("project-find", query);
    return "project-find-result";
  },
  stubList: async () => {
    record("project-list");
    return "project-list-result";
  },
}));

const runPlugin = await import("../../src/vendor/mpr-plugins/run/index.ts?vendor-command-index-tail");
const sendPlugin = await import("../../src/vendor/mpr-plugins/send/index.ts?vendor-command-index-tail");
const sendTextPlugin = await import("../../src/vendor/mpr-plugins/send-text/index.ts?vendor-command-index-tail");
const sendEnterPlugin = await import("../../src/vendor/mpr-plugins/send-enter/index.ts?vendor-command-index-tail");
const takePlugin = await import("../../src/vendor/mpr-plugins/take/index.ts?vendor-command-index-tail");
const locatePlugin = await import("../../src/vendor/mpr-plugins/locate/index.ts?vendor-command-index-tail");
const restartPlugin = await import("../../src/vendor/mpr-plugins/restart/index.ts?vendor-command-index-tail");
const viewPlugin = await import("../../src/vendor/mpr-plugins/view/index.ts?vendor-command-index-tail");
const cleanupPlugin = await import("../../src/vendor/mpr-plugins/cleanup/index.ts?vendor-command-index-tail");
const learnPlugin = await import("../../src/vendor/mpr-plugins/learn/index.ts?vendor-command-index-tail");
const projectPlugin = await import("../../src/vendor/mpr-plugins/project/index.ts?vendor-command-index-tail");

function ctx(source: "cli" | "api", args: unknown, writer?: (...parts: unknown[]) => void) {
  return { source, args, writer } as any;
}

beforeEach(reset);

describe("tail coverage for vendor command index wrappers", () => {
  test("dispatches API shapes and writer paths for pane command wrappers", async () => {
    const out: string[] = [];
    const writer = (...parts: unknown[]) => out.push(parts.map(String).join(" "));

    await expect(runPlugin.default(ctx("api", { target: "s:1", text: "pwd" }, writer))).resolves.toEqual({ ok: true, output: undefined });
    await expect(sendPlugin.default(ctx("api", { target: "s:2", text: "raw" }, writer))).resolves.toEqual({ ok: true, output: undefined });
    await expect(sendTextPlugin.default(ctx("api", { target: "s:3", text: "typed" }, writer))).resolves.toEqual({ ok: true, output: undefined });
    await expect(sendEnterPlugin.default(ctx("api", { target: "s:4", N: 3 }, writer))).resolves.toEqual({ ok: true, output: undefined });
    await expect(sendEnterPlugin.default(ctx("api", { target: "s:5", count: 2 }, writer))).resolves.toEqual({ ok: true, output: undefined });

    expect(calls.map((c) => c.name)).toEqual(["run", "send", "send-text", "send-enter", "send-enter"]);
    expect(out).toContain('send-enter:{"target":"s:5","count":2}');
  });

  test("covers take, locate, restart, view, cleanup, learn, and project wrapper branches", async () => {
    await expect(takePlugin.default(ctx("api", { source: "donor:1", target: "receiver" }))).resolves.toMatchObject({ ok: true });
    await expect(takePlugin.default(ctx("api", {}))).resolves.toEqual({ ok: false, error: "source is required" });
    await expect(locatePlugin.default(ctx("cli", ["neo", "--path", "--json"]))).resolves.toMatchObject({ ok: true });
    await expect(restartPlugin.default(["--no-update", "--ref", "alpha"] as any)).resolves.toMatchObject({ ok: true });
    await expect(restartPlugin.default(["--help"] as any)).resolves.toMatchObject({ ok: true, output: expect.stringContaining("usage: maw restart") });
    await expect(viewPlugin.default(ctx("cli", ["neo", "main", "--clean", "--kill", "--wake", "--split=anchor"]))).resolves.toMatchObject({ ok: true });
    await expect(viewPlugin.default(ctx("cli", []))).resolves.toEqual({ ok: false, error: expect.stringContaining("usage: maw view") });
    await expect(cleanupPlugin.default(ctx("cli", ["--zombies", "--yes"]))).resolves.toMatchObject({ ok: true });
    await expect(cleanupPlugin.default(ctx("cli", ["--prune-stale", "--ask", "--dry-run"]))).resolves.toMatchObject({ ok: true });
    await expect(cleanupPlugin.default(ctx("cli", []))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("maw cleanup") });
    await expect(learnPlugin.default(ctx("cli", ["repo", "--fast"]))).resolves.toEqual({ ok: true, output: expect.stringContaining("learn:repo:fast") });
    await expect(learnPlugin.default(ctx("cli", ["repo", "--fast", "--deep"]))).resolves.toEqual({ ok: false, error: expect.stringContaining("mutually exclusive") });
    await expect(learnPlugin.default(ctx("cli", ["repo", "--bad"]))).resolves.toEqual({ ok: false, error: expect.stringContaining("unknown flag") });
    await expect(learnPlugin.default(ctx("cli", []))).resolves.toEqual({ ok: false, error: expect.stringContaining("usage: maw learn") });
    await expect(projectPlugin.default(ctx("cli", []))).resolves.toMatchObject({ ok: true, output: expect.stringContaining("project-help") });
    await expect(projectPlugin.default(ctx("cli", ["learn", "https://example.test/repo.git"]))).resolves.toEqual({ ok: true, output: expect.stringContaining("project-learn") });
    await expect(projectPlugin.default(ctx("cli", ["incubate", "https://example.test/repo.git"]))).resolves.toEqual({ ok: true, output: expect.stringContaining("project-incubate") });
    await expect(projectPlugin.default(ctx("cli", ["search", "maw"]))).resolves.toEqual({ ok: true, output: expect.stringContaining("project-find") });
    await expect(projectPlugin.default(ctx("cli", ["list"]))).resolves.toEqual({ ok: true, output: expect.stringContaining("project-list") });
    await expect(projectPlugin.default(ctx("cli", ["unknown"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("unknown subcommand") });

    expect(calls.map((c) => c.name)).toContain("project-list");
  });

  test("returns captured logs when implementations throw", async () => {
    failures.run = new Error("run failed");
    await expect(runPlugin.default(ctx("cli", ["s:1", "pwd"]))).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("run:"),
      output: expect.stringContaining("run:"),
    });

    failures.restart = new Error("restart failed");
    await expect(restartPlugin.default({ source: "cli", args: ["--no-update"] } as any)).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("restart:"),
      output: expect.stringContaining("restart:"),
    });
  });
});
