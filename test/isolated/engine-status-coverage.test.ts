/**
 * StatusDetector branch coverage — isolated because it mocks ssh/tmux transport.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

type TestSession = {
  name: string;
  windows: { index: number; name: string; active: boolean }[];
};

let now = 100_000;
const realDateNow = Date.now;
let paneCommands: Record<string, string> = {};
let captures: Record<string, string | Error> = {};
let hostExecCalls: string[] = [];
let captureCalls: string[] = [];

mock.module("../../src/config", () => mockConfigModule(() => ({ host: "local" })));

mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({
    hostExec: async (cmd: string) => {
      hostExecCalls.push(cmd);
      if (cmd.includes("list-panes")) {
        return Object.entries(paneCommands)
          .map(([target, command]) => `${target}|||${command}`)
          .join("\n");
      }
      return "";
    },
    capture: async (target: string, lines = 80) => {
      captureCalls.push(`${target}:${lines}`);
      const value = captures[target];
      if (value instanceof Error) throw value;
      return value ?? "";
    },
  }),
);

const { StatusDetector, markRealFeedEvent } = await import("../../src/engine/status.ts?engine-status-coverage");

function makeWs() {
  const messages: any[] = [];
  return {
    messages,
    ws: {
      send: (msg: string) => messages.push(JSON.parse(msg)),
    },
  };
}

const sessions: TestSession[] = [
  { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
];

describe("StatusDetector isolated coverage", () => {
  beforeEach(() => {
    now = 100_000;
    Date.now = () => now;
    paneCommands = {};
    captures = {};
    hostExecCalls = [];
    captureCalls = [];
    new StatusDetector().pruneState([]);
  });

  afterEach(() => {
    new StatusDetector().pruneState([]);
    Date.now = realDateNow;
  });

  test("returns early for empty session lists", async () => {
    const detector = new StatusDetector();

    await detector.detect([], new Set(), new Set());

    expect(hostExecCalls).toEqual([]);
    expect(captureCalls).toEqual([]);
    expect(detector.getStatus("oracles:1")).toBeNull();
  });

  test("tracks agent panes, reports shell crashes, clears them, and suppresses when real feed is recent", async () => {
    const detector = new StatusDetector();
    const { ws, messages } = makeWs();
    const feedEvents: any[] = [];
    const clients = new Set([ws as any]);
    const listeners = new Set([(event: any) => feedEvents.push(event)]);

    paneCommands = { "oracles:1": "claude" };
    await detector.detect(sessions, clients, listeners);

    expect(detector.getStatus("oracles:1")).toBe("ready");
    expect(captureCalls).toEqual([]);

    paneCommands = { "oracles:1": "zsh" };
    captures = { "oracles:1": "shell prompt" };
    await detector.detect(sessions, clients, listeners);

    expect(detector.getStatus("oracles:1")).toBe("crashed");
    expect(detector.getCrashedAgents(sessions)).toEqual([
      { target: "oracles:1", name: "pulse-oracle", session: "oracles" },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "feed",
      event: {
        oracle: "pulse",
        host: "local",
        event: "Error",
        project: "oracles",
        message: "crashed",
        ts: 100_000,
      },
    });
    expect(feedEvents).toHaveLength(1);
    expect(feedEvents[0].event).toBe("Error");

    detector.clearCrashed("oracles:1");
    detector.clearCrashed("missing:1");
    expect(detector.getStatus("oracles:1")).toBe("idle");

    paneCommands = { "oracles:1": "claude" };
    await detector.detect(sessions, clients, listeners);
    markRealFeedEvent("pulse");

    messages.length = 0;
    feedEvents.length = 0;
    paneCommands = { "oracles:1": "zsh" };
    await detector.detect(sessions, clients, listeners);

    expect(detector.getStatus("oracles:1")).toBe("crashed");
    expect(messages).toEqual([]);
    expect(feedEvents).toEqual([]);
  });

  test("hashes idle panes after stripping status bars, ignores failed captures, and prunes closed targets", async () => {
    const detector = new StatusDetector();
    const twoPaneSessions: TestSession[] = [
      {
        name: "oracles",
        windows: [
          { index: 1, name: "pulse-oracle", active: true },
          { index: 2, name: "ghost-oracle", active: false },
        ],
      },
    ];

    paneCommands = { "oracles:1": "zsh", "oracles:2": "fish" };
    captures = {
      "oracles:1": [
        "\x1b[31m━━\x1b[0m",
        "real output",
        "📁 /tmp/project",
        "📡 connected",
        "⏵ prompt",
        "❯",
        "current: 1 latest: 2",
        "bypass permissions",
        "auto-accept",
        "",
      ].join("\n"),
      "oracles:2": new Error("pane closed during capture"),
    };

    await detector.detect(twoPaneSessions, new Set(), new Set());

    const state = (detector as any).state as Map<string, { hash: string; changedAt: number; status: string }>;
    const pulseState = state.get("oracles:1")!;
    expect(pulseState.status).toBe("idle");
    expect(pulseState.hash).toBe(Bun.hash("real output").toString(36));
    expect(pulseState.changedAt).toBe(100_000);
    expect(state.get("oracles:2")?.hash).toBe(Bun.hash("").toString(36));

    now = 101_000;
    paneCommands = { "oracles:1": "bash" };
    captures = {
      "oracles:1": [
        "real output",
        "📁 /different/path",
        "📡 reconnecting",
        "⏵ still prompt",
        "",
      ].join("\n"),
    };

    await detector.detect(sessions, new Set(), new Set());

    const stablePulseState = state.get("oracles:1")!;
    expect(stablePulseState.hash).toBe(pulseState.hash);
    expect(stablePulseState.changedAt).toBe(100_000);
    expect(detector.getStatus("oracles:2")).toBeNull();
    expect(captureCalls).toEqual(["oracles:1:20", "oracles:2:20", "oracles:1:20"]);
  });
});
