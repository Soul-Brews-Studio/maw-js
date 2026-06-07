/** Isolated coverage for src/vendor/mpr-plugins/awaken/index.ts and impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

type AwakenCall = { name: string; opts: Record<string, unknown> };

type ResolveResult =
  | { type: "local" | "self-node"; target: string }
  | { type: "error"; detail?: string; hint?: string }
  | null;

const handlerCalls: AwakenCall[] = [];
const budCalls: AwakenCall[] = [];
const sendCalls: Array<{ target: string; text: string }> = [];
const listSessionsCalls: number[] = [];
const resolveCalls: Array<{ name: string; config: unknown; sessions: unknown[] }> = [];
const paneCommandCalls: string[] = [];

let handlerMode: "ok" | "log" | "error" | "noisy-error" = "ok";
let config: Record<string, unknown> = { port: 4747 };
let sessions: unknown[] = [{ name: "session", windows: [] }];
let resolveResult: ResolveResult = { type: "local", target: "session:oracle.0" };
let paneCommands: Array<string | Error> = ["claude"];
let sendError: Error | null = null;
let logs: string[] = [];
let stderrWrites: string[] = [];
let fakeNow = 1_000;

const originalLog = console.log;
const originalError = console.error;
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalSetTimeout = globalThis.setTimeout;
const originalDateNow = Date.now;

mock.module(join(root, "src/vendor/mpr-plugins/awaken/impl"), () => ({
  cmdAwaken: async (name: string, opts: Record<string, unknown>) => {
    handlerCalls.push({ name, opts });
    if (handlerMode === "log") console.log("awaken log", opts.trigger ?? "default");
    if (handlerMode === "noisy-error") {
      console.error("captured failure");
      throw new Error("hidden failure");
    }
    if (handlerMode === "error") throw new Error("plain failure");
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/bud/impl"), () => ({
  cmdBud: async (name: string, opts: Record<string, unknown>) => {
    budCalls.push({ name, opts });
    if (name === "bud-fail") throw new Error("bud exploded");
  },
}));

mock.module(join(root, "src/vendor/mpr-plugins/send-text/impl"), () => ({
  cmdSendText: async (input: { target: string; text: string }) => {
    sendCalls.push(input);
    if (sendError) throw sendError;
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls.push(Date.now());
    return sessions;
  },
  resolveTarget: (name: string, cfg: unknown, sess: unknown[]) => {
    resolveCalls.push({ name, config: cfg, sessions: sess });
    return resolveResult;
  },
  getPaneCommand: async (target: string) => {
    paneCommandCalls.push(target);
    const next = paneCommands.length > 1 ? paneCommands.shift()! : paneCommands[0];
    if (next instanceof Error) throw next;
    return next;
  },
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/awaken/index.ts?awaken-index-coverage");
const { cmdAwaken } = await import("../../src/vendor/mpr-plugins/awaken/impl.ts?awaken-impl-coverage");

function setStdinTty(value: boolean | undefined) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  handlerCalls.length = 0;
  budCalls.length = 0;
  sendCalls.length = 0;
  listSessionsCalls.length = 0;
  resolveCalls.length = 0;
  paneCommandCalls.length = 0;
  handlerMode = "ok";
  config = { port: 4747 };
  sessions = [{ name: "session", windows: [] }];
  resolveResult = { type: "local", target: "session:oracle.0" };
  paneCommands = ["claude"];
  sendError = null;
  logs = [];
  stderrWrites = [];
  fakeNow = 1_000;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  (process.stderr as any).write = (chunk: unknown) => { stderrWrites.push(String(chunk)); return true; };
  (globalThis as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
    fn(...args);
    return 0;
  };
  Date.now = () => fakeNow;
  setStdinTty(false);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  (process.stderr as any).write = originalStderrWrite;
  (globalThis as any).setTimeout = originalSetTimeout;
  Date.now = originalDateNow;
  if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  else delete (process.stdin as any).isTTY;
});

describe("awaken plugin index", () => {
  test("exports command metadata", () => {
    expect(command).toEqual({
      name: "awaken",
      description: "Bud + wake + fire /awaken — yeast-budding plus awakening ritual.",
    });
  });

  test("CLI validates missing/help/flag-looking names without invoking implementation", async () => {
    expect(await handler({ source: "cli", args: [] })).toEqual({
      ok: false,
      error: expect.stringContaining("usage: maw awaken <name>"),
    });
    expect(await handler({ source: "cli", args: ["--help"] })).toEqual({
      ok: false,
      error: expect.stringContaining("usage: maw awaken <name>"),
    });

    const flagName = await handler({ source: "cli", args: ["--bogus"] });
    expect(flagName.ok).toBe(false);
    expect(flagName.error).toContain("looks like a flag");
    expect(handlerCalls).toEqual([]);
  });

  test("CLI parses and forwards awaken plus bud-compatible flags", async () => {
    handlerMode = "log";
    const result = await handler({
      source: "cli",
      args: [
        "sprout",
        "--from", "parent",
        "--repo", "Org/sprout-oracle",
        "--org", "Org",
        "--issue", "31",
        "--note", "hello",
        "--nickname", "Sprout",
        "--trigger", "/custom",
        "--no-trigger",
        "--fast",
        "--root",
        "--dry-run",
        "--split",
        "--seed",
        "--blank",
        "--signal-on-birth",
        "--yes",
      ],
    });

    expect(result).toEqual({ ok: true, output: "awaken log /custom" });
    expect(handlerCalls).toEqual([{ name: "sprout", opts: {
      from: "parent",
      repo: "Org/sprout-oracle",
      org: "Org",
      issue: 31,
      note: "hello",
      nickname: "Sprout",
      trigger: "/custom",
      noTrigger: true,
      fast: true,
      root: true,
      dryRun: true,
      split: true,
      seed: true,
      blank: true,
      signalOnBirth: true,
      yes: true,
    } }]);
  });

  test("CLI -y alias and writer path suppress captured output", async () => {
    handlerMode = "log";
    const written: string[] = [];
    const result = await handler({
      source: "cli",
      args: ["sprout", "-y"],
      writer: (...args: unknown[]) => written.push(args.map(String).join(" ")),
    });

    expect(result).toEqual({ ok: true, output: undefined });
    expect(handlerCalls[0]).toEqual({ name: "sprout", opts: expect.objectContaining({ yes: true }) });
    expect(written).toEqual(["awaken log default"]);
  });

  test("API requires name and forwards typed options with non-TTY yes default", async () => {
    expect(await handler({ source: "api", args: {} })).toEqual({ ok: false, error: "name required" });

    await expect(handler({
      source: "api",
      args: {
        name: "api-sprout",
        from: "parent",
        repo: "Org/api-sprout-oracle",
        org: "Org",
        issue: 5,
        note: "api note",
        nickname: "API Sprout",
        trigger: "/start",
        noTrigger: true,
        fast: true,
        root: true,
        dryRun: true,
        split: true,
        seed: true,
        blank: true,
        signalOnBirth: true,
      },
    })).resolves.toEqual({ ok: true, output: undefined });

    expect(handlerCalls).toEqual([{ name: "api-sprout", opts: {
      from: "parent",
      repo: "Org/api-sprout-oracle",
      org: "Org",
      issue: 5,
      note: "api note",
      nickname: "API Sprout",
      trigger: "/start",
      noTrigger: true,
      fast: true,
      root: true,
      dryRun: true,
      split: true,
      seed: true,
      blank: true,
      signalOnBirth: true,
      yes: true,
    } }]);
  });

  test("handler restores console and reports captured logs before thrown messages", async () => {
    handlerMode = "noisy-error";
    expect(await handler({ source: "cli", args: ["sprout"] })).toEqual({
      ok: false,
      error: "captured failure",
      output: "captured failure",
    });

    handlerMode = "error";
    expect(await handler({ source: "cli", args: ["sprout"] })).toEqual({
      ok: false,
      error: "plain failure",
      output: undefined,
    });
  });
});

describe("awaken implementation", () => {
  test("dry-run buds and reports whether a trigger would be sent without resolving tmux", async () => {
    await cmdAwaken("dry", { dryRun: true, trigger: "/hello", yes: true });

    expect(budCalls).toEqual([{ name: "dry", opts: { dryRun: true, trigger: "/hello", yes: true } }]);
    expect(logs.join("\n")).toContain("[dry-run] would send");
    expect(logs.join("\n")).toContain("/hello");
    expect(resolveCalls).toEqual([]);
    expect(sendCalls).toEqual([]);

    logs = [];
    budCalls.length = 0;
    await cmdAwaken("dry-no-trigger", { dryRun: true, noTrigger: true, yes: true });
    expect(budCalls).toEqual([{ name: "dry-no-trigger", opts: { dryRun: true, noTrigger: true, yes: true } }]);
    expect(logs.join("\n")).toContain("would NOT fire /awaken");
  });

  test("--no-trigger buds and wakes but skips pane resolution and send", async () => {
    await cmdAwaken("quiet", { noTrigger: true, yes: true });

    expect(budCalls).toEqual([{ name: "quiet", opts: { noTrigger: true, yes: true } }]);
    expect(logs.join("\n")).toContain("--no-trigger: bud + wake done");
    expect(listSessionsCalls).toEqual([]);
    expect(sendCalls).toEqual([]);
  });

  test("resolves a woken pane, waits until an agent command appears, and sends trigger by oracle name", async () => {
    paneCommands = ["zsh", new Error("transient tmux"), "claude"];
    await cmdAwaken("sprout", { trigger: "/awaken --fast", yes: true });

    expect(budCalls).toEqual([{ name: "sprout", opts: { trigger: "/awaken --fast", yes: true } }]);
    expect(resolveCalls).toEqual([{ name: "sprout", config, sessions }]);
    expect(paneCommandCalls).toEqual(["session:oracle.0", "session:oracle.0", "session:oracle.0"]);
    expect(sendCalls).toEqual([{ target: "sprout", text: "/awaken --fast" }]);
    expect(logs.join("\n")).toContain("firing");
    expect(logs.join("\n")).toContain("awakened");
  });

  test("unresolved targets and send failures log manual recovery hints", async () => {
    resolveResult = { type: "error", detail: "not found" };
    await cmdAwaken("missing", { yes: true });

    expect(sendCalls).toEqual([]);
    expect(logs.join("\n")).toContain("could not resolve missing after wake");
    expect(logs.join("\n")).toContain("maw send-text missing /awaken");

    logs = [];
    resolveResult = { type: "local", target: "session:oracle.0" };
    sendError = new Error("tmux refused");
    await cmdAwaken("sprout", { yes: true });

    expect(sendCalls).toEqual([{ target: "sprout", text: "/awaken" }]);
    expect(logs.join("\n")).toContain("send-text failed: tmux refused");
    expect(logs.join("\n")).toContain("try manually: maw send-text sprout /awaken");
  });

  test("times out portably when no agent command appears", async () => {
    Date.now = () => {
      fakeNow += 501;
      return fakeNow;
    };
    paneCommands = ["zsh"];

    await cmdAwaken("slow", { yes: true });

    expect(sendCalls).toEqual([]);
    expect(paneCommandCalls.length).toBeGreaterThan(1);
    expect(logs.join("\n")).toContain("timeout waiting for agent");
    expect(logs.join("\n")).toContain("pane may still be in zsh");
  });

  test("TTY prompt prints plan and aborts safely when confirmation is unavailable", async () => {
    setStdinTty(true);

    await cmdAwaken("cautious", { repo: "Org/cautious-oracle", from: "parent", fast: true });

    expect(budCalls).toEqual([]);
    expect(logs.join("\n")).toContain("Will create:");
    expect(logs.join("\n")).toContain("oracle:  cautious");
    expect(logs.join("\n")).toContain("repo:    Org/cautious-oracle");
    expect(logs.join("\n")).toContain("from:    parent");
    expect(logs.join("\n")).toContain("mode:    fast");
    expect(logs.join("\n")).toContain("aborted — no changes made");
  });

  test("non-TTY execution treats omitted --yes as safe to proceed", async () => {
    setStdinTty(false);

    await cmdAwaken("rooted", { root: true, seed: true, blank: true, split: true, noTrigger: true });

    expect(budCalls).toEqual([{ name: "rooted", opts: { root: true, seed: true, blank: true, split: true, noTrigger: true } }]);
    expect(stderrWrites).toEqual([]);
    expect(logs.join("\n")).toContain("--no-trigger: bud + wake done");
  });
});
