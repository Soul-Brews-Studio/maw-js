/** Extra isolated coverage for thin vendor index wrappers not covered elsewhere. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const prImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/pr/impl");
const resumeImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/resume/impl");
const reunionImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/reunion/impl");
const uiImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/ui/impl");
const healthImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/health/impl");

type Source = "cli" | "api";
type CommandName = "peek" | "pr" | "resume" | "reunion" | "ui" | "health" | "stop" | "triggers";
type Calls = Record<CommandName, unknown[]>;

type Case = {
  name: CommandName;
  plugin: { command: { name: string | string[]; description: string }; default: (ctx: unknown) => Promise<unknown> };
  cliArgs: string[];
  cliPayload: unknown;
  apiPayload: unknown;
};

let calls: Calls;
let activeErrors: Partial<Record<CommandName, Error>>;
let throwBeforeLog: Set<CommandName>;
let stderrBeforeThrow: Set<CommandName>;

function resetCalls() {
  calls = {
    peek: [],
    pr: [],
    resume: [],
    reunion: [],
    ui: [],
    health: [],
    stop: [],
    triggers: [],
  };
  activeErrors = {};
  throwBeforeLog = new Set();
  stderrBeforeThrow = new Set();
}

function formatPayload(payload: unknown) {
  if (Array.isArray(payload)) return payload.length > 0 ? payload.map(String).join("|") : "<empty>";
  return payload === undefined ? "<default>" : String(payload);
}

function record(command: CommandName, payload: unknown) {
  calls[command].push(payload);
  const error = activeErrors[command];
  if (error && throwBeforeLog.has(command)) throw error;

  const formatted = formatPayload(payload);
  console.log(`${command}:stdout:${formatted}`);

  if (error) {
    if (stderrBeforeThrow.has(command)) console.error(`${command}:stderr:${formatted}`);
    throw error;
  }
}

mock.module("maw-js/commands/shared/comm", () => ({
  cmdPeek: async (target?: string) => record("peek", target),
}));

mock.module(prImplPath, () => ({
  cmdPr: async (window?: string) => record("pr", window),
}));

mock.module(resumeImplPath, () => ({
  cmdResume: async (target?: string) => record("resume", target),
}));

mock.module(reunionImplPath, () => ({
  cmdReunion: async (target?: string) => record("reunion", target),
}));

mock.module(uiImplPath, () => ({
  cmdUi: async (args: string[] = []) => record("ui", args),
}));

mock.module(healthImplPath, () => ({
  cmdHealth: async () => record("health", undefined),
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdSleep: async () => record("stop", undefined),
}));

mock.module("maw-js/commands/shared/triggers", () => ({
  cmdTriggers: async () => record("triggers", undefined),
}));

const peekPlugin = await import("../../src/vendor/mpr-plugins/peek/index.ts?vendor-more-indexes-extra-coverage");
const prPlugin = await import("../../src/vendor/mpr-plugins/pr/index.ts?vendor-more-indexes-extra-coverage");
const resumePlugin = await import("../../src/vendor/mpr-plugins/resume/index.ts?vendor-more-indexes-extra-coverage");
const reunionPlugin = await import("../../src/vendor/mpr-plugins/reunion/index.ts?vendor-more-indexes-extra-coverage");
const uiPlugin = await import("../../src/vendor/mpr-plugins/ui/index.ts?vendor-more-indexes-extra-coverage");
const healthPlugin = await import("../../src/vendor/mpr-plugins/health/index.ts?vendor-more-indexes-extra-coverage");
const stopPlugin = await import("../../src/vendor/mpr-plugins/stop/index.ts?vendor-more-indexes-extra-coverage");
const triggersPlugin = await import("../../src/vendor/mpr-plugins/triggers/index.ts?vendor-more-indexes-extra-coverage");

const cases: Case[] = [
  { name: "peek", plugin: peekPlugin, cliArgs: ["neo", "ignored"], cliPayload: "neo", apiPayload: undefined },
  { name: "pr", plugin: prPlugin, cliArgs: ["review", "ignored"], cliPayload: "review", apiPayload: undefined },
  { name: "resume", plugin: resumePlugin, cliArgs: ["parked", "ignored"], cliPayload: "parked", apiPayload: undefined },
  { name: "reunion", plugin: reunionPlugin, cliArgs: ["sync", "ignored"], cliPayload: "sync", apiPayload: undefined },
  { name: "ui", plugin: uiPlugin, cliArgs: ["--status", "--json"], cliPayload: ["--status", "--json"], apiPayload: [] },
  { name: "health", plugin: healthPlugin, cliArgs: ["ignored"], cliPayload: undefined, apiPayload: undefined },
  { name: "stop", plugin: stopPlugin, cliArgs: ["ignored"], cliPayload: undefined, apiPayload: undefined },
  { name: "triggers", plugin: triggersPlugin, cliArgs: ["ignored"], cliPayload: undefined, apiPayload: undefined },
];

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

function expectedCalls(payloadKey: "cliPayload" | "apiPayload") {
  return Object.fromEntries(cases.map((entry) => [entry.name, [entry[payloadKey]]])) as Calls;
}

function activateErrors(options: { quiet?: boolean; stderr?: boolean } = {}) {
  activeErrors = Object.fromEntries(cases.map((entry) => [entry.name, new Error(`${entry.name} impl failed`)]));
  throwBeforeLog = new Set(options.quiet ? cases.map((entry) => entry.name) : []);
  stderrBeforeThrow = new Set(options.stderr ? cases.map((entry) => entry.name) : []);
}

beforeEach(() => {
  resetCalls();
});

describe("extra isolated coverage for remaining vendor index wrappers", () => {
  test("exports command metadata for the covered wrappers", () => {
    expect(cases.map((entry) => entry.plugin.command.name)).toEqual([
      "peek",
      "pr",
      "resume",
      "reunion",
      "ui",
      "health",
      ["stop", "rest"],
      "triggers",
    ]);
    expect(peekPlugin.command.description).toContain("Peek");
    expect(prPlugin.command.description).toContain("pull requests");
    expect(resumePlugin.command.description).toContain("Resume");
    expect(reunionPlugin.command.description).toContain("reunion");
    expect(uiPlugin.command.description).toContain("web UI");
    expect(healthPlugin.command.description).toContain("System health");
    expect(stopPlugin.command.description).toContain("Stop ALL");
    expect(triggersPlugin.command.description).toContain("event triggers");
  });

  test("dispatches CLI arguments to implementation commands and captures buffered logs", async () => {
    for (const entry of cases) {
      await expect(entry.plugin.default(ctx("cli", entry.cliArgs))).resolves.toEqual({
        ok: true,
        output: `${entry.name}:stdout:${formatPayload(entry.cliPayload)}`,
      });
    }

    expect(calls).toEqual(expectedCalls("cliPayload"));
  });

  test("uses API/default argument shapes without leaking caller payloads", async () => {
    for (const entry of cases) {
      await expect(entry.plugin.default(ctx("api", { ignored: entry.cliArgs }))).resolves.toEqual({
        ok: true,
        output: `${entry.name}:stdout:${formatPayload(entry.apiPayload)}`,
      });
    }

    expect(calls).toEqual(expectedCalls("apiPayload"));
  });

  test("streams console output to ctx.writer and omits buffered output", async () => {
    const out = writer();

    for (const entry of cases) {
      await expect(entry.plugin.default(ctx("cli", entry.cliArgs, out.fn))).resolves.toEqual({ ok: true, output: undefined });
    }

    expect(out.lines).toEqual(cases.map((entry) => `${entry.name}:stdout:${formatPayload(entry.cliPayload)}`));
    expect(calls).toEqual(expectedCalls("cliPayload"));
  });

  test("returns thrown error messages when implementations fail before logging", async () => {
    activateErrors({ quiet: true });

    for (const entry of cases) {
      await expect(entry.plugin.default(ctx("cli", entry.cliArgs))).resolves.toEqual({
        ok: false,
        error: `${entry.name} impl failed`,
        output: undefined,
      });
    }

    expect(calls).toEqual(expectedCalls("cliPayload"));
  });

  test("prefers captured stdout/stderr over thrown errors on failure", async () => {
    activateErrors({ stderr: true });

    for (const entry of cases) {
      const payload = formatPayload(entry.cliPayload);
      const output = `${entry.name}:stdout:${payload}\n${entry.name}:stderr:${payload}`;
      await expect(entry.plugin.default(ctx("cli", entry.cliArgs))).resolves.toEqual({
        ok: false,
        error: output,
        output,
      });
    }

    expect(calls).toEqual(expectedCalls("cliPayload"));
  });

  test("routes logged failures through ctx.writer while returning thrown error text", async () => {
    const out = writer();
    activateErrors({ stderr: true });

    for (const entry of cases) {
      await expect(entry.plugin.default(ctx("cli", entry.cliArgs, out.fn))).resolves.toEqual({
        ok: false,
        error: `${entry.name} impl failed`,
        output: undefined,
      });
    }

    expect(out.lines).toEqual(cases.flatMap((entry) => {
      const payload = formatPayload(entry.cliPayload);
      return [`${entry.name}:stdout:${payload}`, `${entry.name}:stderr:${payload}`];
    }));
    expect(calls).toEqual(expectedCalls("cliPayload"));
  });
});
