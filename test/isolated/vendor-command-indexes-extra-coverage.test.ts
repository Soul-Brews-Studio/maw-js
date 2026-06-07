import { beforeEach, describe, expect, mock, test } from "bun:test";

const locateImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/locate/impl");
const runImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/run/impl");
const sendEnterImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send-enter/impl");
const sendTextImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send-text/impl");
const sendImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/send/impl");
const soulSyncImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/soul-sync/impl");

type Source = "cli" | "api";

type DispatchCall = { command: string; opts: Record<string, unknown> };

let dispatchCalls: DispatchCall[] = [];
let parseCalls: Array<{ command: string; args: string[] }> = [];
let activeError: Error | null = null;

function record(command: string, opts: Record<string, unknown>) {
  dispatchCalls.push({ command, opts });
  if (activeError) throw activeError;
  console.log(`${command}:ok:${JSON.stringify(opts)}`);
}

function parseTargetText(command: string, args: string[], usage: string, requireText: boolean) {
  parseCalls.push({ command, args });
  const targetIdx = args.findIndex((arg) => !arg.startsWith("-"));
  if (targetIdx < 0) throw new Error(usage);
  const target = args[targetIdx];
  const text = args.slice(targetIdx + 1).join(" ");
  if (requireText && text.length === 0) throw new Error(`${usage} — text is required`);
  return { target, text };
}

mock.module(locateImplPath, () => ({
  cmdLocate: async (oracle: string | undefined, opts: { path?: boolean; json?: boolean } = {}) => {
    record("locate", { oracle, ...opts });
  },
}));

mock.module(runImplPath, () => ({
  parseRunArgs: (args: string[]) => parseTargetText("run", args, 'usage: maw run <target> "<cmd>"', false),
  cmdRun: async (opts: { target: string; text: string }) => record("run", opts),
}));

mock.module(sendEnterImplPath, () => ({
  parseSendEnterArgs: (args: string[]) => {
    parseCalls.push({ command: "send-enter", args });
    let target = "";
    let count = 1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--N") {
        count = Number(args[++i]);
        if (!Number.isFinite(count) || count < 1) throw new Error("--N requires a positive integer");
      } else if (!target && !arg.startsWith("-")) {
        target = arg;
      }
    }
    if (!target) throw new Error("usage: maw send-enter <target> [--N <count>]");
    return { target, count };
  },
  cmdSendEnter: async (opts: { target: string; count?: number }) => record("send-enter", opts),
}));

mock.module(sendTextImplPath, () => ({
  parseSendTextArgs: (args: string[]) => parseTargetText("send-text", args, 'usage: maw send-text <target> "<text>"', true),
  cmdSendText: async (opts: { target: string; text: string }) => record("send-text", opts),
}));

mock.module(sendImplPath, () => ({
  parseSendArgs: (args: string[]) => parseTargetText("send", args, 'usage: maw send <target> "<text>"', true),
  cmdSend: async (opts: { target: string; text: string }) => record("send", opts),
}));

mock.module(soulSyncImplPath, () => ({
  cmdSoulSync: async (target?: string, opts?: { from?: boolean }) => {
    record("soul-sync", { target, from: opts?.from ?? false });
    return [];
  },
  cmdSoulSyncProject: async () => {
    record("soul-sync-project", {});
    return [];
  },
}));

const { command: locateCommand, default: locateHandler } = await import(
  "../../src/vendor/mpr-plugins/locate/index.ts?vendor-command-indexes-extra-coverage"
);
const { command: runCommand, default: runHandler } = await import(
  "../../src/vendor/mpr-plugins/run/index.ts?vendor-command-indexes-extra-coverage"
);
const { command: sendEnterCommand, default: sendEnterHandler } = await import(
  "../../src/vendor/mpr-plugins/send-enter/index.ts?vendor-command-indexes-extra-coverage"
);
const { command: sendTextCommand, default: sendTextHandler } = await import(
  "../../src/vendor/mpr-plugins/send-text/index.ts?vendor-command-indexes-extra-coverage"
);
const { command: sendCommand, default: sendHandler } = await import(
  "../../src/vendor/mpr-plugins/send/index.ts?vendor-command-indexes-extra-coverage"
);
const { command: soulSyncCommand, default: soulSyncHandler } = await import(
  "../../src/vendor/mpr-plugins/soul-sync/index.ts?vendor-command-indexes-extra-coverage"
);

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
  dispatchCalls = [];
  parseCalls = [];
  activeError = null;
});

describe("extra isolated coverage for thin vendor command indexes", () => {
  test("exports command metadata for all covered index modules", () => {
    expect([locateCommand.name, runCommand.name, sendEnterCommand.name, sendTextCommand.name, sendCommand.name, soulSyncCommand.name]).toEqual([
      "locate",
      "run",
      "send-enter",
      "send-text",
      "send",
      "soul-sync",
    ]);
    expect(runCommand.description).toContain("Enter");
    expect(sendCommand.description).toContain("raw text");
  });

  test("locate parses CLI flags, dispatches to implementation, captures writer output, and reports failures", async () => {
    const out = writer();
    await expect(locateHandler(ctx("cli", ["neo", "--path", "--json"], out.fn))).resolves.toEqual({ ok: true, output: undefined });
    expect(dispatchCalls).toEqual([{ command: "locate", opts: { oracle: "neo", path: true, json: true } }]);
    expect(out.lines.join("\n")).toContain("locate:ok");

    activeError = new Error("locate failed");
    await expect(locateHandler(ctx("cli", ["trinity"]))).resolves.toEqual({
      ok: false,
      error: "locate failed",
      output: undefined,
    });
  });

  test("run covers CLI parsing, API opts, writer output, and parser errors", async () => {
    await expect(runHandler(ctx("cli", ["pane", "echo", "--flag"]))).resolves.toMatchObject({ ok: true });
    await expect(runHandler(ctx("api", { target: "api-pane", text: "pwd" }))).resolves.toMatchObject({ ok: true });
    expect(parseCalls).toEqual([{ command: "run", args: ["pane", "echo", "--flag"] }]);
    expect(dispatchCalls).toEqual([
      { command: "run", opts: { target: "pane", text: "echo --flag" } },
      { command: "run", opts: { target: "api-pane", text: "pwd" } },
    ]);

    const out = writer();
    await expect(runHandler(ctx("api", {}, out.fn))).resolves.toEqual({ ok: true, output: undefined });
    expect(dispatchCalls.at(-1)).toEqual({ command: "run", opts: { target: "", text: "" } });
    expect(out.lines.join("\n")).toContain("run:ok");

    await expect(runHandler(ctx("cli", ["--only-flag"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw run") });
  });

  test("send and send-text cover CLI/API dispatch, validation, and implementation errors", async () => {
    await expect(sendHandler(ctx("cli", ["pane", "hello", "--literal"]))).resolves.toMatchObject({ ok: true });
    await expect(sendTextHandler(ctx("api", { target: "oracle", text: "/awaken" }))).resolves.toMatchObject({ ok: true });
    expect(dispatchCalls).toEqual([
      { command: "send", opts: { target: "pane", text: "hello --literal" } },
      { command: "send-text", opts: { target: "oracle", text: "/awaken" } },
    ]);

    await expect(sendHandler(ctx("cli", ["pane"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("text is required") });
    await expect(sendTextHandler(ctx("cli", ["--flag"]))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("usage: maw send-text") });

    activeError = new Error("send impl failed");
    await expect(sendHandler(ctx("api", { target: "pane", text: "hi" }))).resolves.toEqual({
      ok: false,
      error: "send impl failed",
      output: undefined,
    });
  });

  test("send-enter covers CLI count parsing, API count fallbacks, writer output, and validation", async () => {
    await expect(sendEnterHandler(ctx("cli", ["--N", "3", "pane"]))).resolves.toMatchObject({ ok: true });
    await expect(sendEnterHandler(ctx("api", { target: "api-pane", N: 2 }))).resolves.toMatchObject({ ok: true });
    await expect(sendEnterHandler(ctx("api", { target: "count-pane", count: 4 }))).resolves.toMatchObject({ ok: true });
    await expect(sendEnterHandler(ctx("api", { target: "default-pane" }))).resolves.toMatchObject({ ok: true });
    expect(dispatchCalls).toEqual([
      { command: "send-enter", opts: { target: "pane", count: 3 } },
      { command: "send-enter", opts: { target: "api-pane", count: 2 } },
      { command: "send-enter", opts: { target: "count-pane", count: 4 } },
      { command: "send-enter", opts: { target: "default-pane", count: 1 } },
    ]);

    const out = writer();
    await expect(sendEnterHandler(ctx("cli", ["pane"], out.fn))).resolves.toEqual({ ok: true, output: undefined });
    expect(out.lines.join("\n")).toContain("send-enter:ok");

    await expect(sendEnterHandler(ctx("cli", ["--N", "0", "pane"]))).resolves.toMatchObject({ ok: false, error: "--N requires a positive integer" });
  });

  test("soul-sync dispatches project, push, and pull forms through dynamic imports and reports failures", async () => {
    await expect(soulSyncHandler(ctx("cli", ["--project"]))).resolves.toMatchObject({ ok: true });
    await expect(soulSyncHandler(ctx("cli", ["peer-a"]))).resolves.toMatchObject({ ok: true });
    await expect(soulSyncHandler(ctx("cli", ["--from", "peer-b"]))).resolves.toMatchObject({ ok: true });
    await expect(soulSyncHandler(ctx("api", { ignored: true }))).resolves.toMatchObject({ ok: true });
    expect(dispatchCalls).toEqual([
      { command: "soul-sync-project", opts: {} },
      { command: "soul-sync", opts: { target: "peer-a", from: false } },
      { command: "soul-sync", opts: { target: "peer-b", from: true } },
      { command: "soul-sync", opts: { target: undefined, from: false } },
    ]);

    activeError = new Error("soul sync failed");
    await expect(soulSyncHandler(ctx("cli", ["peer-c"]))).resolves.toEqual({
      ok: false,
      error: "soul sync failed",
      output: undefined,
    });
  });
});
