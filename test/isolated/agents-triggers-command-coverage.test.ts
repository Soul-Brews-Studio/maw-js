import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const realSdk = await import("../../src/sdk");
const realConfig = await import("../../src/config");

type TmuxSession = { name: string; windows: Array<{ index: number; name: string; active: boolean }> };
type TmuxPane = { command: string; target: string; pid?: number };

type Trigger = { on: string; repo?: string; timeout?: number; action: string; once?: boolean };
type TriggerHistory = { index: number; result: { ts: number; ok: boolean } };

let sessions: TmuxSession[] = [];
let panes: TmuxPane[] = [];
let config: Record<string, unknown> = { node: "test-node" };
let triggers: Trigger[] = [];
let history: TriggerHistory[] = [];

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ...realSdk,
  tmux: {
    ...realSdk.tmux,
    listAll: async () => sessions,
    listPanes: async () => panes,
  },
  getTriggers: () => triggers,
  getTriggerHistory: () => history,
}));

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  ...realConfig,
  loadConfig: () => config,
}));

const { cmdAgents } = await import("../../src/commands/shared/agents");
const { cmdTriggers } = await import("../../src/commands/shared/triggers");

const realDateNow = Date.now;
let logs: string[] = [];
let logSpy: ReturnType<typeof mock>;

async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  logs = [];
  await fn();
  return logs;
}

beforeEach(() => {
  sessions = [];
  panes = [];
  config = { node: "test-node" };
  triggers = [];
  history = [];
  Date.now = () => 1_700_000_000_000;
  logs = [];
  logSpy = mock((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  console.log = logSpy as unknown as typeof console.log;
});

afterEach(() => {
  Date.now = realDateNow;
  mock.restore();
});

describe("cmdAgents command coverage", () => {
  test("prints the not-yet-implemented federation branch for --node", async () => {
    const out = await captureLogs(() => cmdAgents({ node: "white" }));
    expect(out.join("\n")).toContain("--node <name> federation not yet implemented");
    expect(out.join("\n")).toContain("Soul-Brews-Studio/maw-js/issues");
  });

  test("prints JSON rows from mocked tmux sessions and panes", async () => {
    sessions = [{ name: "42-maw", windows: [{ index: 0, name: "mawjs-oracle", active: true }] }];
    panes = [{ command: "claude", target: "42-maw:0.0", pid: 123 }];

    const out = await captureLogs(() => cmdAgents({ json: true }));
    const rows = JSON.parse(out.join("\n"));
    expect(rows).toEqual([{ node: "test-node", session: "42-maw", window: "mawjs-oracle", oracle: "mawjs", state: "active", pid: 123 }]);
  });

  test("prints empty and table render branches", async () => {
    let out = await captureLogs(() => cmdAgents({}));
    expect(out).toEqual(["no oracle agents found"]);

    sessions = [{ name: "43-home", windows: [{ index: 2, name: "homekeeper-oracle", active: true }] }];
    panes = [{ command: "zsh", target: "43-home:2.0" }];

    out = await captureLogs(() => cmdAgents({}));
    expect(out[0]).toContain("NODE");
    expect(out[1]).toContain("---");
    expect(out.join("\n")).toContain("homekeeper-oracle");
    expect(out.join("\n")).toContain("idle");
    expect(out.join("\n")).toContain("?");
  });
});

describe("cmdTriggers command coverage", () => {
  test("prints help text when no triggers are configured", async () => {
    const out = await captureLogs(() => cmdTriggers());
    const text = out.join("\n");
    expect(text).toContain("No triggers configured");
    expect(text).toContain('"triggers"');
    expect(text).toContain("issue-close");
  });

  test("prints configured triggers with colors, filters, truncation, and relative history", async () => {
    const now = Date.now();
    triggers = [
      { on: "issue-close", repo: "Soul-Brews-Studio/maw-js", action: "maw hey pulse-oracle issue closed", once: true },
      { on: "pr-merge", repo: "Soul-Brews-Studio/maw-js", action: "maw done neo-mawjs" },
      { on: "agent-idle", timeout: 30, action: "maw sleep {agent}" },
      { on: "agent-wake", action: "maw hey awakened-oracle hi" },
      { on: "agent-crash", action: "maw hey ops-oracle crash happened" },
      { on: "custom-event", action: "x".repeat(50) },
    ];
    history = [
      { index: 0, result: { ts: now - 5_000, ok: true } },
      { index: 1, result: { ts: now - 5 * 60_000, ok: false } },
      { index: 2, result: { ts: now - 5 * 3_600_000, ok: true } },
      { index: 3, result: { ts: now - 2 * 86_400_000, ok: true } },
    ];

    const out = await captureLogs(() => cmdTriggers());
    const text = out.join("\n");
    expect(text).toContain("Workflow Triggers");
    expect(text).toContain("6 configured");
    expect(text).toContain("[once]");
    expect(text).toContain("timeout: 30s");
    expect(text).toContain("custom-event");
    expect(text).toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...");
    expect(text).toContain("5s ago");
    expect(text).toContain("5m ago");
    expect(text).toContain("5h ago");
    expect(text).toContain("2d ago");
  });
});
