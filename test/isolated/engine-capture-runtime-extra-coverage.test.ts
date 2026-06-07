import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { mockSshModule } from "../helpers/mock-ssh";

const srcRoot = join(import.meta.dir, "../..");
const realTmux = await import("../../src/core/transport/tmux");
const realFsPromises = await import("node:fs/promises");
const realOs = await import("node:os");
const realChildProcess = await import("node:child_process");

type SessionInfo = { name: string; windows: { index: number; name: string; active: boolean }[] };
type SentMessage = Record<string, any>;

type WsStub = {
  data: { target?: string | null; previewTargets?: Set<string> };
  sent: SentMessage[];
  raw: string[];
  send: (message: string) => void;
};

let captureCalls: Array<{ target: string; lines?: number }> = [];
let captureBodies: Record<string, string> = {};
let captureFailures = new Set<string>();
let listAllCalls = 0;
let listAllImpl: () => Promise<SessionInfo[]> = async () => [];
let paneCommandTargets: string[][] = [];
let paneCommands: Record<string, string> = {};

let mockHome = "/tmp/maw-hooks-home";
let readFileCalls: Array<{ path: string; encoding?: string }> = [];
let readFileImpl: (path: string, encoding?: string) => Promise<string> = async () => "{}";
let spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
let unrefCalls = 0;
let spawnImpl: (command: string, args: string[], options: any) => { unref: () => void } = (command, args, options) => {
  spawnCalls.push({ command, args, options });
  return { unref: () => { unrefCalls += 1; } };
};

const originalAgentName = process.env.CLAUDE_AGENT_NAME;
const originalMawHome = process.env.MAW_HOME;
const originalMawConfigDir = process.env.MAW_CONFIG_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeWs(data: WsStub["data"] = {}): WsStub {
  const ws: WsStub = {
    data,
    sent: [],
    raw: [],
    send(message: string) {
      ws.raw.push(message);
      ws.sent.push(JSON.parse(message));
    },
  };
  return ws;
}

function resetCaptureState() {
  captureCalls = [];
  captureBodies = {};
  captureFailures = new Set<string>();
  listAllCalls = 0;
  listAllImpl = async () => [];
  paneCommandTargets = [];
  paneCommands = {};
}

function resetHookState() {
  mockHome = "/tmp/maw-hooks-home";
  readFileCalls = [];
  readFileImpl = async () => "{}";
  spawnCalls = [];
  unrefCalls = 0;
  spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { unref: () => { unrefCalls += 1; } };
  };
  restoreEnv("CLAUDE_AGENT_NAME", originalAgentName);
  delete process.env.MAW_HOME;
  delete process.env.MAW_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = join(mockHome, ".config");
}

afterAll(() => {
  restoreEnv("MAW_HOME", originalMawHome);
  restoreEnv("MAW_CONFIG_DIR", originalMawConfigDir);
  restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
});

async function importHooks(label: string) {
  return import(`../../src/core/runtime/hooks.ts?engine-capture-runtime-extra=${label}-${Date.now()}-${Math.random()}`);
}

mock.module(join(srcRoot, "src/core/transport/ssh"), () =>
  mockSshModule({
    capture: async (target: string, lines?: number) => {
      captureCalls.push({ target, lines });
      if (captureFailures.has(target)) throw new Error(`capture failed for ${target}`);
      return captureBodies[target] ?? "";
    },
  }),
);

mock.module(join(srcRoot, "src/core/transport/tmux"), () => ({
  ...realTmux,
  tmux: {
    ...realTmux.tmux,
    async listAll() {
      listAllCalls += 1;
      return listAllImpl();
    },
    async getPaneCommands(targets: string[]) {
      paneCommandTargets.push([...targets]);
      const out: Record<string, string> = {};
      for (const target of targets) out[target] = paneCommands[target] ?? "";
      return out;
    },
  },
}));

mock.module("fs/promises", () => ({
  ...realFsPromises,
  readFile: async (path: string, encoding?: string) => {
    readFileCalls.push({ path, encoding });
    return readFileImpl(path, encoding);
  },
}));

mock.module("os", () => ({
  ...realOs,
  homedir: () => mockHome,
}));

mock.module("child_process", () => ({
  ...realChildProcess,
  spawn: (command: string, args: string[], options: any) => spawnImpl(command, args, options),
}));

const {
  pushCapture,
  pushPreviews,
  broadcastSessions,
  sendBusyAgents,
} = await import("../../src/engine/capture.ts?engine-capture-runtime-extra");

describe("engine/capture extra runtime coverage", () => {
  beforeEach(() => resetCaptureState());

  test("pushCapture skips missing targets, sends changed content, suppresses duplicates, and reports capture errors", async () => {
    const lastContent = new Map<any, string>();
    const noTarget = makeWs({ target: null });
    await pushCapture(noTarget as any, lastContent);
    expect(noTarget.sent).toEqual([]);
    expect(captureCalls).toEqual([]);

    const ws = makeWs({ target: "oracles:1" });
    captureBodies["oracles:1"] = "first capture";
    await pushCapture(ws as any, lastContent);
    expect(captureCalls).toEqual([{ target: "oracles:1", lines: 80 }]);
    expect(ws.sent).toEqual([{ type: "capture", target: "oracles:1", content: "first capture" }]);

    await pushCapture(ws as any, lastContent);
    expect(ws.sent).toHaveLength(1);

    captureFailures.add("oracles:1");
    await pushCapture(ws as any, lastContent);
    expect(ws.sent.at(-1)).toEqual({ type: "error", error: "capture failed for oracles:1" });
  });

  test("pushPreviews batches changed preview captures, ignores failed panes, and suppresses unchanged previews", async () => {
    const lastPreviews = new Map<any, Map<string, string>>();
    const none = makeWs({ previewTargets: new Set() });
    await pushPreviews(none as any, lastPreviews);
    expect(none.sent).toEqual([]);
    expect(captureCalls).toEqual([]);

    const ws = makeWs({ previewTargets: new Set(["oracles:1", "oracles:2", "oracles:3"]) });
    captureBodies = {
      "oracles:1": "alpha preview",
      "oracles:2": "beta preview",
    };
    captureFailures.add("oracles:3");

    await pushPreviews(ws as any, lastPreviews);

    expect(captureCalls).toEqual([
      { target: "oracles:1", lines: 15 },
      { target: "oracles:2", lines: 15 },
      { target: "oracles:3", lines: 15 },
    ]);
    expect(ws.sent).toEqual([{ type: "previews", data: {
      "oracles:1": "alpha preview",
      "oracles:2": "beta preview",
    } }]);
    expect(lastPreviews.get(ws as any)?.get("oracles:1")).toBe("alpha preview");

    captureCalls = [];
    await pushPreviews(ws as any, lastPreviews);
    expect(captureCalls).toHaveLength(3);
    expect(ws.sent).toHaveLength(1);

    captureBodies["oracles:2"] = "beta preview changed";
    await pushPreviews(ws as any, lastPreviews);
    expect(ws.sent.at(-1)).toEqual({ type: "previews", data: { "oracles:2": "beta preview changed" } });
  });

  test("broadcastSessions returns cached sessions for empty clients, broadcasts local plus peer sessions, and keeps cache on tmux failure", async () => {
    const cached = [{ name: "cached", windows: [] }];
    const cache = { sessions: cached as SessionInfo[], json: "cached-json" };

    const emptyResult = await broadcastSessions(new Set(), cache, []);
    expect(emptyResult).toBe(cached);
    expect(listAllCalls).toBe(0);

    const wsA = makeWs();
    const wsB = makeWs();
    const clients = new Set<any>([wsA, wsB]);
    const local = [{ name: "local", windows: [{ index: 1, name: "codex", active: true }] }];
    const peers = [{ name: "peer", windows: [{ index: 7, name: "remote", active: false }] }];
    listAllImpl = async () => local;

    const result = await broadcastSessions(clients, cache, peers);

    expect(result).toEqual(local);
    expect(cache.sessions).toEqual(local);
    expect(JSON.parse(cache.json)).toEqual([...local, ...peers]);
    expect(wsA.sent).toEqual([{ type: "sessions", sessions: [...local, ...peers] }]);
    expect(wsB.sent).toEqual(wsA.sent);

    listAllImpl = async () => { throw new Error("tmux unavailable"); };
    const fallback = await broadcastSessions(clients, cache, []);
    expect(fallback).toEqual(local);
    expect(wsA.sent).toHaveLength(1);
  });

  test("sendBusyAgents emits only panes whose command looks like an agent", async () => {
    const ws = makeWs();
    const sessions: SessionInfo[] = [
      { name: "oracles", windows: [
        { index: 1, name: "pulse", active: true },
        { index: 2, name: "shell", active: false },
      ] },
      { name: "codex", windows: [{ index: 0, name: "versioned", active: true }] },
    ];
    paneCommands = {
      "oracles:1": "claude",
      "oracles:2": "zsh",
      "codex:0": "2.1.121",
    };

    await sendBusyAgents(ws as any, sessions);

    expect(paneCommandTargets).toEqual([["oracles:1", "oracles:2", "codex:0"]]);
    expect(ws.sent).toEqual([{ type: "recent", agents: [
      { target: "oracles:1", name: "pulse", session: "oracles" },
      { target: "codex:0", name: "versioned", session: "codex" },
    ] }]);

    ws.sent = [];
    paneCommands = { "oracles:1": "zsh", "oracles:2": "bash", "codex:0": "vim" };
    await sendBusyAgents(ws as any, sessions);
    expect(ws.sent).toEqual([]);
  });
});

describe("core/runtime/hooks extra coverage", () => {
  beforeEach(() => resetHookState());
  afterEach(() => resetHookState());

  test("runHook caches parsed config, expands tilde scripts, fills default channel, and detaches spawned hooks", async () => {
    const { runHook } = await importHooks("configured");
    readFileImpl = async () => JSON.stringify({
      hooks: {
        after_send: "~/bin/after-send",
        after_plain: "/usr/local/bin/plain-hook",
      },
    });
    process.env.CLAUDE_AGENT_NAME = "env-oracle";

    await runHook("missing_event", { to: "pulse", message: "ignored" });
    expect(readFileCalls).toEqual([{ path: join(mockHome, ".config", "maw", "maw.hooks.json"), encoding: "utf-8" }]);
    expect(spawnCalls).toEqual([]);

    await runHook("after_send", { to: "pulse", message: "hello" });
    expect(readFileCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("sh");
    expect(spawnCalls[0].args).toEqual(["-c", join(mockHome, "bin/after-send")]);
    expect(spawnCalls[0].options.stdio).toBe("ignore");
    expect(spawnCalls[0].options.detached).toBe(true);
    expect(spawnCalls[0].options.env).toMatchObject({
      MAW_EVENT: "after_send",
      MAW_FROM: "env-oracle",
      MAW_TO: "pulse",
      MAW_MESSAGE: "hello",
      MAW_CHANNEL: "hey",
    });
    expect(typeof spawnCalls[0].options.env.MAW_TIMESTAMP).toBe("string");
    expect(unrefCalls).toBe(1);

    await runHook("after_plain", { from: "explicit", to: "pulse", message: "chan", channel: "dm" });
    expect(spawnCalls.at(-1)?.args).toEqual(["-c", "/usr/local/bin/plain-hook"]);
    expect(spawnCalls.at(-1)?.options.env).toMatchObject({
      MAW_FROM: "explicit",
      MAW_CHANNEL: "dm",
    });
    expect(unrefCalls).toBe(2);
  });

  test("runHook treats unreadable config as empty and never lets spawn failures escape", async () => {
    readFileImpl = async () => { throw new Error("no config"); };
    const emptyHooks = await importHooks("empty");
    await expect(emptyHooks.runHook("after_send", { to: "pulse", message: "hello" })).resolves.toBeUndefined();
    expect(spawnCalls).toEqual([]);

    readFileImpl = async () => JSON.stringify({ hooks: { after_send: "~/bin/broken" } });
    spawnImpl = () => { throw new Error("spawn blocked"); };
    delete process.env.CLAUDE_AGENT_NAME;
    const throwingHooks = await importHooks("spawn-throws");

    await expect(throwingHooks.runHook("after_send", { to: "pulse", message: "hello" })).resolves.toBeUndefined();
    expect(readFileCalls.at(-1)).toEqual({ path: join(mockHome, ".config", "maw", "maw.hooks.json"), encoding: "utf-8" });
    expect(unrefCalls).toBe(0);
  });
});
