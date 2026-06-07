import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

let fetchCalls: FetchCall[] = [];
let fetchQueue: Array<MockResponse | Error> = [];
let listSessionsValue: any[] = [];
let sendKeysCalls: Array<{ target: string; message: string }> = [];
let getPaneCommandValue = "claude";
let resolveTargetValue: any = { type: "local", target: "alpha:oracle" };
let runHookCalls: Array<{ name: string; payload: unknown }> = [];
let resolveOraclePaneValue: string | null = "alpha:oracle.0";
let mkdirCalls: Array<{ path: string; opts?: unknown }> = [];
let appendFileCalls: Array<{ path: string; data: string }> = [];
let appendFileError: Error | null = null;

const loadConfigMock = () => ({ oracleUrl: "https://oracle.test" });
const listSessionsMock = async () => listSessionsValue;
const sendKeysMock = async (target: string, message: string) => {
  sendKeysCalls.push({ target, message });
};
const getPaneCommandMock = async () => getPaneCommandValue;
const resolveTargetMock = () => resolveTargetValue;
const runHookMock = async (name: string, payload: unknown) => {
  runHookCalls.push({ name, payload });
};
const resolveOraclePaneMock = async () => resolveOraclePaneValue;
const mkdirMock = async (path: string, opts?: unknown) => {
  mkdirCalls.push({ path, opts });
};
const appendFileMock = async (path: string, data: string) => {
  appendFileCalls.push({ path, data });
  if (appendFileError) throw appendFileError;
};

mock.module("maw-js/config", () => ({
  loadConfig: loadConfigMock,
}));

mock.module("maw-js/sdk", () => ({
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
  sendKeys: (...args: unknown[]) => sendKeysMock(args[0] as string, args[1] as string),
  getPaneCommand: (...args: unknown[]) => getPaneCommandMock(...args),
  resolveTarget: (...args: unknown[]) => resolveTargetMock(...args),
  runHook: (...args: unknown[]) => runHookMock(args[0] as string, args[1]),
}));

mock.module("maw-js/commands/shared/comm-send", () => ({
  resolveOraclePane: (...args: unknown[]) => resolveOraclePaneMock(...args),
}));

mock.module("fs/promises", () => ({
  mkdir: (...args: unknown[]) => mkdirMock(args[0] as string, args[1]),
  appendFile: (...args: unknown[]) => appendFileMock(args[0] as string, args[1] as string),
}));

mock.module("os", () => ({
  homedir: () => "/home/tester",
  hostname: () => "oracle-host",
}));

const realConsoleLog = console.log;
const realConsoleError = console.error;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), init });
  const next = fetchQueue.shift();
  if (!next) throw new Error(`missing fetch mock for ${String(input)}`);
  if (next instanceof Error) throw next;
  return next as Response;
}) as typeof fetch;

const talkToModules = await Promise.all([
  import("../../src/vendor/mpr-plugins/talk-to/impl.ts?talk-to-impl-coverage"),
  import("../../src/vendor/mpr-plugins/tab/internal/talk-to-impl.ts?tab-talk-to-impl-coverage"),
]);

const talkToCommands = talkToModules.map(mod => mod.cmdTalkTo);

function jsonResponse(data: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe("talk-to impl isolated coverage", () => {
  beforeEach(() => {
    fetchCalls = [];
    fetchQueue = [];
    listSessionsValue = [{ name: "alpha", windows: [] }];
    sendKeysCalls = [];
    getPaneCommandValue = "claude";
    resolveTargetValue = { type: "local", target: "alpha:oracle" };
    runHookCalls = [];
    resolveOraclePaneValue = "alpha:oracle.0";
    mkdirCalls = [];
    appendFileCalls = [];
    appendFileError = null;
    process.env.CLAUDE_AGENT_NAME = "mawjs-codex";
    process.env.CLAUDE_SESSION_ID = "sess-123";
    delete process.env.ORACLE_URL;
    console.log = mock(() => {}) as typeof console.log;
    console.error = mock(() => {}) as typeof console.error;
  });

  afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
    delete process.env.CLAUDE_AGENT_NAME;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.ORACLE_URL;
  });

  test("success path posts to an existing thread, notifies the pane with the full long body, runs hooks, and logs", async () => {
    const message = ["line 1", "x".repeat(1000), "line 3"].join("\n");

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [{ id: 7, title: "channel:alpha", status: "open" }] }),
        jsonResponse({ thread_id: 7, message_id: 11, status: "ok" }),
        jsonResponse({
          thread: { id: 7, title: "channel:alpha", status: "open", created_at: "2026-05-18T00:00:00Z" },
          messages: [{ id: 1, role: "user", content: "hi", created_at: "2026-05-18T00:00:00Z" }],
        }),
      ];
      sendKeysCalls = [];
      runHookCalls = [];
      mkdirCalls = [];
      appendFileCalls = [];

      await cmdTalkTo("alpha", message);

      expect(fetchCalls.slice(-3).map(call => call.url)).toEqual([
        "https://oracle.test/api/threads?limit=50",
        "https://oracle.test/api/thread",
        "https://oracle.test/api/thread/7",
      ]);
      expect(sendKeysCalls).toHaveLength(1);
      expect(sendKeysCalls[0]?.target).toBe("alpha:oracle.0");
      expect(sendKeysCalls[0]?.message).toContain("💬 channel:alpha (#7) — 1 msgs");
      expect(sendKeysCalls[0]?.message).toContain("From: mawjs-codex");
      expect(sendKeysCalls[0]?.message).toContain(`Message:\n${message}\n→ Full copy saved in thread #7`);
      expect(sendKeysCalls[0]?.message).not.toContain("Preview:");
      expect(runHookCalls).toEqual([
        { name: "after_send", payload: { to: "alpha", message: sendKeysCalls[0]?.message } },
      ]);
      expect(mkdirCalls).toEqual([{ path: "/home/tester/.maw", opts: { recursive: true } }]);
      expect(appendFileCalls).toHaveLength(1);
      expect(appendFileCalls[0]?.path).toBe("/home/tester/.maw/maw-log.jsonl");
      expect(appendFileCalls[0]?.data).toContain('"to":"alpha"');
      expect(appendFileCalls[0]?.data).toContain('"target":"alpha:oracle.0"');
      expect(appendFileCalls[0]?.data).toContain('"host":"oracle-host"');
      expect(appendFileCalls[0]?.data).toContain('"sid":"sess-123"');
      expect(appendFileCalls[0]?.data).toContain('"ch":"thread:7"');
    }
  });

  test("thread success with unresolved local target saves to thread only and reports the resolver detail", async () => {
    resolveTargetValue = { type: "error", detail: "ambiguous local target" };

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [] }),
        jsonResponse({ thread_id: 9, message_id: 22, status: "ok" }),
        jsonResponse({
          thread: { id: 9, title: "channel:alpha", status: "open", created_at: "2026-05-18T00:00:00Z" },
          messages: [{ id: 1, role: "user", content: "hi", created_at: "2026-05-18T00:00:00Z" }, { id: 2, role: "assistant", content: "yo", created_at: "2026-05-18T00:01:00Z" }],
        }),
      ];
      sendKeysCalls = [];

      await cmdTalkTo("alpha", "hello there");

      expect(sendKeysCalls).toEqual([]);
      expect(console.log).toHaveBeenCalledWith("\x1b[32m✓\x1b[0m thread #9 updated");
      expect(console.log).toHaveBeenCalledWith("\x1b[33mwarn\x1b[0m: ambiguous local target — message saved to thread only");
    }
  });

  test("fallback path without thread still sends a simple notification when forced and warns on log failures", async () => {
    appendFileError = new Error("disk full");
    resolveTargetValue = { type: "self-node", target: "alpha:oracle" };

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        new Error("oracle offline"),
        jsonResponse({}, 503),
      ];
      sendKeysCalls = [];

      await cmdTalkTo("alpha", "hello from fallback", true);

      expect(sendKeysCalls).toEqual([
        {
          target: "alpha:oracle.0",
          message: "💬 from mawjs-codex\nMessage:\nhello from fallback",
        },
      ]);
      expect(console.error).toHaveBeenCalledWith("\x1b[33mwarn\x1b[0m: thread post failed — falling back to maw hey only");
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("talk-to log write failed: Error: disk full"));
      expect(console.log).toHaveBeenCalledWith("\x1b[32m✓\x1b[0m thread #? + sent → alpha:oracle.0");
    }
  });



  test("thread info fetch failures fall back to unknown message count but still notify", async () => {
    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [{ id: 17, title: "channel:alpha", status: "open" }] }),
        jsonResponse({ thread_id: 17, message_id: 33, status: "ok" }),
        new Error("thread info offline"),
      ];
      sendKeysCalls = [];
      runHookCalls = [];

      await cmdTalkTo("alpha", "short hello");

      expect(sendKeysCalls).toHaveLength(1);
      expect(sendKeysCalls[0]?.message).toContain("💬 channel:alpha (#17) — ? msgs");
      expect(runHookCalls).toEqual([
        { name: "after_send", payload: { to: "alpha", message: sendKeysCalls[0]?.message } },
      ]);
    }
  });

  test("when thread post and target resolution both fail it throws the resolver detail", async () => {
    resolveTargetValue = { type: "error", detail: "ambiguous target" };

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        new Error("threads offline"),
        jsonResponse({}, 500),
      ];
      sendKeysCalls = [];

      await expect(cmdTalkTo("alpha", "hello")).rejects.toThrow("ambiguous target");
      expect(sendKeysCalls).toEqual([]);
    }
  });



  test("thread post network errors after channel lookup fall back to forced notification", async () => {
    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [{ id: 21, title: "channel:alpha", status: "open" }] }),
        new Error("post offline"),
      ];
      sendKeysCalls = [];

      await cmdTalkTo("alpha", "post fallback", true);

      expect(sendKeysCalls).toEqual([{ target: "alpha:oracle.0", message: "💬 from mawjs-codex\nMessage:\npost fallback" }]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Oracle unreachable"));
    }
  });

  test("non-agent panes with a successful thread post save to thread only", async () => {
    getPaneCommandValue = "bash";

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [] }),
        jsonResponse({ thread_id: 44, message_id: 55, status: "ok" }),
        jsonResponse({ thread: { id: 44, title: "channel:alpha", status: "open", created_at: "now" }, messages: [] }),
      ];
      sendKeysCalls = [];

      await cmdTalkTo("alpha", "saved only");

      expect(sendKeysCalls).toEqual([]);
      expect(console.log).toHaveBeenCalledWith("[32m✓[0m thread #44 updated");
      expect(console.log).toHaveBeenCalledWith("[33mwarn[0m: no active Claude in alpha:oracle.0 — message saved to thread only");
    }
  });

  test("without force, a non-agent pane throws when the thread post also failed", async () => {
    getPaneCommandValue = "bash";

    for (const cmdTalkTo of talkToCommands) {
      fetchQueue = [
        jsonResponse({ threads: [] }),
        jsonResponse({}, 500),
      ];

      await expect(cmdTalkTo("alpha", "wake up")).rejects.toThrow(
        "no active Claude session in alpha:oracle.0 (use --force)",
      );
    }
  });
});
