import { beforeEach, describe, expect, mock, test } from "bun:test";

const talkToImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/talk-to/impl");
const findImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/find/impl");
const checkImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/check/impl");
const broadcastImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/broadcast/impl");
const completionsImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/completions/impl");
const overviewImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/overview/impl");

type Source = "cli" | "api";
type CommandName = "talk-to" | "find" | "check" | "broadcast" | "completions" | "overview";

type Calls = {
  talkTo: Array<{ agent: string; message: string; force: boolean }>;
  find: Array<{ keyword: string; opts: { oracle?: string } }>;
  check: Array<{ sub: string; args: string[] }>;
  broadcast: string[];
  completions: Array<string | undefined>;
  overview: string[][];
};

let calls: Calls;
let activeErrors: Partial<Record<CommandName, Error>>;
let logBeforeThrow: Set<CommandName>;

function resetCalls() {
  calls = {
    talkTo: [],
    find: [],
    check: [],
    broadcast: [],
    completions: [],
    overview: [],
  };
  activeErrors = {};
  logBeforeThrow = new Set();
}

function maybeThrow(command: CommandName) {
  const error = activeErrors[command];
  if (!error) return;
  if (logBeforeThrow.has(command)) console.error(`${command}:logged-error`);
  throw error;
}

mock.module(talkToImplPath, () => ({
  cmdTalkTo: async (agent: string, message: string, force: boolean) => {
    calls.talkTo.push({ agent, message, force });
    console.log(`talk-to:${agent}:${message}:${force}`);
    maybeThrow("talk-to");
  },
}));

mock.module(findImplPath, () => ({
  cmdFind: async (keyword: string, opts: { oracle?: string } = {}) => {
    calls.find.push({ keyword, opts });
    console.log(`find:${keyword}:${opts.oracle ?? "all"}`);
    maybeThrow("find");
  },
}));

mock.module(checkImplPath, () => ({
  cmdCheck: (sub: string, args: string[] = []) => {
    calls.check.push({ sub, args });
    console.log(`check:${sub}:${args.join("|")}`);
    maybeThrow("check");
  },
}));

mock.module(broadcastImplPath, () => ({
  cmdBroadcast: async (message: string) => {
    calls.broadcast.push(message);
    console.log(`broadcast:${message || "<empty>"}`);
    maybeThrow("broadcast");
  },
}));

mock.module(completionsImplPath, () => ({
  cmdCompletions: async (shell?: string) => {
    calls.completions.push(shell);
    console.log(`completions:${shell ?? "default"}`);
    maybeThrow("completions");
  },
}));

mock.module(overviewImplPath, () => ({
  cmdOverview: async (args: string[] = []) => {
    calls.overview.push(args);
    console.log(`overview:${args.join("|") || "default"}`);
    maybeThrow("overview");
  },
}));

const talkToPlugin = await import("../../src/vendor/mpr-plugins/talk-to/index.ts?vendor-small-indexes-extra-coverage");
const findPlugin = await import("../../src/vendor/mpr-plugins/find/index.ts?vendor-small-indexes-extra-coverage");
const checkPlugin = await import("../../src/vendor/mpr-plugins/check/index.ts?vendor-small-indexes-extra-coverage");
const broadcastPlugin = await import("../../src/vendor/mpr-plugins/broadcast/index.ts?vendor-small-indexes-extra-coverage");
const completionsPlugin = await import("../../src/vendor/mpr-plugins/completions/index.ts?vendor-small-indexes-extra-coverage");
const overviewPlugin = await import("../../src/vendor/mpr-plugins/overview/index.ts?vendor-small-indexes-extra-coverage");

function ctx(source: Source, args: unknown, writer?: (...parts: unknown[]) => void) {
  return { source, args, writer } as any;
}

function writer() {
  const lines: string[] = [];
  return {
    lines,
    fn: (...parts: unknown[]) => lines.push(parts.map(String).join(" ")),
  };
}

beforeEach(() => {
  resetCalls();
});

describe("extra isolated coverage for small vendor command indexes", () => {
  test("exports command metadata for all covered vendor indexes", () => {
    expect([
      talkToPlugin.command.name,
      findPlugin.command.name,
      checkPlugin.command.name,
      broadcastPlugin.command.name,
      completionsPlugin.command.name,
      overviewPlugin.command.name,
    ]).toEqual(["talk-to", "find", "check", "broadcast", "completions", "overview"]);
    expect(talkToPlugin.command.description).toContain("remote agent");
    expect(findPlugin.command.description).toContain("fleet data");
    expect(checkPlugin.command.description).toContain("prep tools");
    expect(broadcastPlugin.command.description).toContain("all agents");
    expect(completionsPlugin.command.description).toContain("shell completions");
    expect(overviewPlugin.command.description).toContain("fleet overview");
  });

  test("parses CLI arguments and forwards them to each implementation", async () => {
    await expect(talkToPlugin.default(ctx("cli", ["neo", "hello", "there", "--force"]))).resolves.toMatchObject({ ok: true });
    await expect(findPlugin.default(ctx("cli", ["needle", "--oracle", "trinity"]))).resolves.toMatchObject({ ok: true });
    await expect(checkPlugin.default(ctx("cli", ["runtime", "--json"]))).resolves.toMatchObject({ ok: true });
    await expect(broadcastPlugin.default(ctx("cli", ["hello", "fleet"]))).resolves.toMatchObject({ ok: true });
    await expect(completionsPlugin.default(ctx("cli", ["zsh"]))).resolves.toMatchObject({ ok: true });
    await expect(overviewPlugin.default(ctx("cli", ["--json", "--watch"]))).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual({
      talkTo: [{ agent: "neo", message: "hello there", force: true }],
      find: [{ keyword: "needle", opts: { oracle: "trinity" } }],
      check: [{ sub: "runtime", args: ["--json"] }],
      broadcast: ["hello fleet"],
      completions: ["zsh"],
      overview: [["--json", "--watch"]],
    });
  });

  test("uses default or empty API argument shapes consistently", async () => {
    await expect(talkToPlugin.default(ctx("api", { agent: "neo", message: "ignored" }))).resolves.toEqual({
      ok: false,
      error: "usage: maw talk-to <agent> <message> [--force]",
      output: undefined,
    });
    await expect(findPlugin.default(ctx("api", { keyword: "ignored" }))).resolves.toEqual({
      ok: false,
      error: "usage: maw find <keyword> [--oracle <name>]",
      output: undefined,
    });
    await expect(checkPlugin.default(ctx("api", { sub: "ignored" }))).resolves.toMatchObject({ ok: true });
    await expect(broadcastPlugin.default(ctx("api", { message: "ignored" }))).resolves.toMatchObject({ ok: true });
    await expect(completionsPlugin.default(ctx("api", { shell: "fish" }))).resolves.toMatchObject({ ok: true });
    await expect(overviewPlugin.default(ctx("api", { args: ["ignored"] }))).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual({
      talkTo: [],
      find: [],
      check: [{ sub: "tools", args: [] }],
      broadcast: [""],
      completions: [undefined],
      overview: [[]],
    });
  });

  test("captures console output into returned output or the provided writer", async () => {
    const talkToResult = await talkToPlugin.default(ctx("cli", ["morpheus", "wake", "up"]));
    expect(talkToResult).toEqual({ ok: true, output: "talk-to:morpheus:wake up:false" });

    const out = writer();
    const broadcastResult = await broadcastPlugin.default(ctx("cli", ["writer", "path"], out.fn));
    expect(broadcastResult).toEqual({ ok: true, output: undefined });
    expect(out.lines).toEqual(["broadcast:writer path"]);

    const completionsOut = writer();
    const completionsResult = await completionsPlugin.default(ctx("cli", [], completionsOut.fn));
    expect(completionsResult).toEqual({ ok: true, output: undefined });
    expect(completionsOut.lines).toEqual(["completions:default"]);
  });

  test("returns validation and implementation errors for each index", async () => {
    await expect(talkToPlugin.default(ctx("cli", ["neo"]))).resolves.toEqual({
      ok: false,
      error: "usage: maw talk-to <agent> <message> [--force]",
      output: undefined,
    });
    await expect(findPlugin.default(ctx("cli", []))).resolves.toEqual({
      ok: false,
      error: "usage: maw find <keyword> [--oracle <name>]",
      output: undefined,
    });

    activeErrors["talk-to"] = new Error("talk-to impl failed");
    await expect(talkToPlugin.default(ctx("cli", ["neo", "ping"]))).resolves.toEqual({
      ok: false,
      error: "talk-to:neo:ping:false",
      output: "talk-to:neo:ping:false",
    });

    activeErrors = { find: new Error("find impl failed") };
    await expect(findPlugin.default(ctx("cli", ["needle"]))).resolves.toEqual({
      ok: false,
      error: "find:needle:all",
      output: "find:needle:all",
    });

    activeErrors = { check: new Error("check impl failed") };
    logBeforeThrow = new Set(["check"]);
    await expect(checkPlugin.default(ctx("cli", ["tools"]))).resolves.toEqual({
      ok: false,
      error: "check:tools:\ncheck:logged-error",
      output: "check:tools:\ncheck:logged-error",
    });

    activeErrors = { broadcast: new Error("broadcast impl failed") };
    logBeforeThrow = new Set();
    await expect(broadcastPlugin.default(ctx("cli", ["boom"]))).resolves.toEqual({
      ok: false,
      error: "broadcast:boom",
      output: "broadcast:boom",
    });

    activeErrors = { completions: new Error("completions impl failed") };
    await expect(completionsPlugin.default(ctx("cli", ["fish"]))).resolves.toEqual({
      ok: false,
      error: "completions:fish",
      output: "completions:fish",
    });

    activeErrors = { overview: new Error("overview impl failed") };
    await expect(overviewPlugin.default(ctx("cli", ["--bad"]))).resolves.toEqual({
      ok: false,
      error: "overview:--bad",
      output: "overview:--bad",
    });
  });
});
