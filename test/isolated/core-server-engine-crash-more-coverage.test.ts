import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

type CrashedAgent = { name: string; target: string; session: string };

let config: Record<string, unknown> = {};
let buildNames: string[] = [];
let sendTextCalls: Array<{ target: string; command: string }> = [];
let throwingTargets: Set<string> = new Set();
let logs: string[] = [];

const originalLog = console.log;

mock.module("../../src/config", () => ({
  ...mockConfigModule(() => config),
  buildCommand: (name: string) => {
    buildNames.push(name);
    return `restart ${name}`;
  },
}));

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    sendText: async (target: string, command: string) => {
      sendTextCalls.push({ target, command });
      if (throwingTargets.has(target)) throw new Error(`missing pane: ${target}`);
    },
  },
}));

const { handleCrashedAgents } = await import(
  "../../src/engine/engine-crash.ts?core-server-engine-crash-more-coverage"
);

beforeEach(() => {
  config = {};
  buildNames = [];
  sendTextCalls = [];
  throwingTargets = new Set();
  logs = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});

afterEach(() => {
  console.log = originalLog;
});

describe("handleCrashedAgents", () => {
  test("does nothing when autoRestart is disabled", async () => {
    config = { autoRestart: false };
    const { status, calls } = fakeStatus([
      { name: "alpha-oracle", target: "alpha:1", session: "alpha" },
    ]);
    const { ws, messages } = fakeWs();
    const feedEvents: unknown[] = [];

    await handleCrashedAgents(
      status as any,
      [{ name: "alpha", windows: [] }],
      new Set([ws as any]),
      new Set([(event) => feedEvents.push(event)]),
    );

    expect(calls.getCrashedAgents).toEqual([]);
    expect(calls.clearCrashed).toEqual([]);
    expect(buildNames).toEqual([]);
    expect(sendTextCalls).toEqual([]);
    expect(messages).toEqual([]);
    expect(feedEvents).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("restarts crashed agents and broadcasts feed events to clients and listeners", async () => {
    config = { autoRestart: true };
    const sessions = [{ name: "project-a", windows: [{ index: 1, name: "alpha-oracle", active: true }] }];
    const { status, calls } = fakeStatus([
      { name: "alpha-oracle", target: "project-a:1", session: "project-a" },
      { name: "helper", target: "project-b:2", session: "project-b" },
    ]);
    const firstClient = fakeWs();
    const secondClient = fakeWs();
    const feedEvents: unknown[] = [];

    await handleCrashedAgents(
      status as any,
      sessions,
      new Set([firstClient.ws as any, secondClient.ws as any]),
      new Set([(event) => feedEvents.push(event)]),
    );

    expect(calls.getCrashedAgents).toEqual([sessions]);
    expect(buildNames).toEqual(["alpha-oracle", "helper"]);
    expect(sendTextCalls).toEqual([
      { target: "project-a:1", command: "restart alpha-oracle" },
      { target: "project-b:2", command: "restart helper" },
    ]);
    expect(calls.clearCrashed).toEqual(["project-a:1", "project-b:2"]);

    const firstMessages = firstClient.messages.map(parseFeedMessage);
    const secondMessages = secondClient.messages.map(parseFeedMessage);
    expect(secondMessages).toEqual(firstMessages);
    expect(feedEvents).toEqual(firstMessages.map((msg) => msg.event));
    expect(firstMessages).toHaveLength(2);
    expect(firstMessages[0].event).toMatchObject({
      oracle: "alpha",
      host: "local",
      event: "SubagentStart",
      project: "project-a",
      sessionId: "",
      message: "auto-restarted after crash",
    });
    expect(firstMessages[1].event).toMatchObject({
      oracle: "helper",
      host: "local",
      event: "SubagentStart",
      project: "project-b",
    });
    expect(Date.parse(firstMessages[0].event.timestamp)).not.toBeNaN();
    expect(typeof firstMessages[0].event.ts).toBe("number");
    expect(logs.join("\n")).toContain("auto-restart");
    expect(logs.join("\n")).toContain("alpha-oracle");
  });

  test("swallows per-agent tmux failures and continues restarting later agents", async () => {
    config = { autoRestart: true };
    throwingTargets.add("dead:1");
    const { status, calls } = fakeStatus([
      { name: "dead-oracle", target: "dead:1", session: "dead-session" },
      { name: "alive-oracle", target: "alive:2", session: "alive-session" },
    ]);
    const client = fakeWs();
    const feedEvents: unknown[] = [];

    await handleCrashedAgents(
      status as any,
      [{ name: "mixed", windows: [] }],
      new Set([client.ws as any]),
      new Set([(event) => feedEvents.push(event)]),
    );

    expect(buildNames).toEqual(["dead-oracle", "alive-oracle"]);
    expect(sendTextCalls).toEqual([
      { target: "dead:1", command: "restart dead-oracle" },
      { target: "alive:2", command: "restart alive-oracle" },
    ]);
    expect(calls.clearCrashed).toEqual(["alive:2"]);
    expect(client.messages).toHaveLength(1);
    expect(parseFeedMessage(client.messages[0]).event).toMatchObject({
      oracle: "alive",
      project: "alive-session",
      message: "auto-restarted after crash",
    });
    expect(feedEvents).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("dead-oracle");
    expect(logs.join("\n")).toContain("alive-oracle");
  });
});

function fakeStatus(agents: CrashedAgent[]) {
  const calls = {
    getCrashedAgents: [] as unknown[][],
    clearCrashed: [] as string[],
  };
  return {
    calls,
    status: {
      getCrashedAgents: (sessions: unknown[]) => {
        calls.getCrashedAgents.push(sessions);
        return agents;
      },
      clearCrashed: (target: string) => {
        calls.clearCrashed.push(target);
      },
    },
  };
}

function fakeWs() {
  const messages: string[] = [];
  return {
    messages,
    ws: {
      send: (message: string) => { messages.push(message); },
    },
  };
}

function parseFeedMessage(message: string) {
  return JSON.parse(message) as {
    type: "feed";
    event: {
      timestamp: string;
      oracle: string;
      host: string;
      event: string;
      project: string;
      sessionId: string;
      message: string;
      ts: number;
    };
  };
}
