/**
 * Thirteenth-pass isolated branch coverage for src/commands/shared/comm-send.ts.
 *
 * Fully mocked: covers helper edge branches plus cmdSend forgiving/fallback paths
 * without touching live tmux, network, inbox, trust, or consent state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type ResolvedTarget =
  | { type: "local" | "self-node"; target: string }
  | { type: "peer"; target: string; node: string; peerUrl: string }
  | { type: "error"; detail: string; hint?: string }
  | null;

type ReceiverInboxInput = {
  query: string;
  target?: string;
  to: string;
  from: string;
  message: string;
  config: any;
};

type ReceiverInboxResult =
  | { ok: true; oracle: string; inboxDir: string; path: string; filename: string }
  | { ok: false; reason: string }
  | null;

let config: any;
let listSessionsReturn: any[];
let resolveTargetReturn: ResolvedTarget;
let findPeerUrl: string | null;
let getPaneCommandReturn: string;
let captureResponses: Array<string | Error>;
let sendKeysCalls: Array<{ target: string; text: string }>;
let curlFetchCalls: Array<{ url: string; options: any }>;
let curlFetchHandler: (url: string, options: any) => { ok: boolean; status?: number; data?: any } | Promise<{ ok: boolean; status?: number; data?: any }>;
let runHookCalls: Array<{ name: string; payload: any }>;
let logMessageCalls: Array<{ from: string; to: string; message: string; route: string }>;
let emitFeedCalls: Array<{ event: string; oracle: string; host: string; message: string; port: number; data: any }>;
let defaultInboxCalls: ReceiverInboxInput[];
let defaultInboxResult: ReceiverInboxResult;
let shouldWakeCalls: Array<{ target: string; input: any }>;
let shouldWakeReturn: { wake: boolean };
let shouldWakeError: Error | null;
let scopesMode: "ok" | "throw";
let trustAddCalls: Array<{ sender: string; target: string }>;
let trustAddError: Error | null;
let consentDecision: { allow: boolean; message?: string; exitCode?: number };
let tmuxPaneList: string;
let sleepCalls: number[];

mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    async run() { return tmuxPaneList; }
    async tryRun() { return tmuxPaneList; }
  }
  return { Tmux: MockTmux, tmux: new MockTmux() };
});

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => listSessionsReturn,
  capture: async () => {
    const next = captureResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  sendKeys: async (target: string, text: string) => {
    sendKeysCalls.push({ target, text });
  },
  getPaneCommand: async () => getPaneCommandReturn,
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes((cmd ?? "").trim()),
  findPeerForTarget: async () => findPeerUrl,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return curlFetchHandler(url, options);
  },
  runHook: async (name: string, payload: any) => {
    runHookCalls.push({ name, payload });
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
  cfgLimit: () => 24,
}));

mock.module(join(srcRoot, "src/commands/shared/comm-log-feed"), () => ({
  logMessage: (from: string, to: string, message: string, route: string) => {
    logMessageCalls.push({ from, to, message, route });
  },
  emitFeed: (event: string, oracle: string, host: string, message: string, port: number, data: any) => {
    emitFeedCalls.push({ event, oracle, host, message, port, data });
  },
}));

mock.module(join(srcRoot, "src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async (input: ReceiverInboxInput) => {
    defaultInboxCalls.push(input);
    return defaultInboxResult;
  },
}));

mock.module(join(srcRoot, "src/lib/oracle-manifest"), () => ({
  findOracle: () => undefined,
}));

mock.module(join(srcRoot, "src/commands/shared/should-auto-wake"), () => ({
  shouldAutoWake: (target: string, input: any) => {
    shouldWakeCalls.push({ target, input });
    if (shouldWakeError) throw shouldWakeError;
    return shouldWakeReturn;
  },
}));

mock.module(join(srcRoot, "src/commands/shared/scope-acl"), () => ({
  loadAllScopes: () => {
    if (scopesMode === "throw") throw new Error("scope disk unreadable");
    return [{ name: "prod" }];
  },
  evaluateAclFromDisk: () => "allow",
}));

mock.module(join(srcRoot, "src/lib/trust-store"), () => ({
  cmdAdd: (sender: string, target: string) => {
    if (trustAddError) throw trustAddError;
    trustAddCalls.push({ sender, target });
  },
}));

mock.module(join(srcRoot, "src/core/consent/gate"), () => ({
  maybeGateConsent: async () => consentDecision,
}));

const origSleep = Bun.sleep.bind(Bun);
const origExit = process.exit;
const origErr = console.error;
const origLog = console.log;
const origAgentName = process.env.CLAUDE_AGENT_NAME;
const origConsent = process.env.MAW_CONSENT;
const origAclBypass = process.env.MAW_ACL_BYPASS;

(Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
  sleepCalls.push(ms);
};

const {
  checkPaneIdle,
  cmdSend,
  formatSignedMessage,
  resolveMyName,
  resolveOraclePane,
  resolveTeamWorkspaceMemberTarget,
} = await import("../../src/commands/shared/comm-send");

let exitCode: number | undefined;
let errs: string[];
let logs: string[];

async function runCmd(fn: () => Promise<unknown>) {
  exitCode = undefined;
  errs = [];
  logs = [];
  console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  } finally {
    console.error = origErr;
    console.log = origLog;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  config = { node: "test-node", oracle: "sender", port: 3456, namedPeers: [] };
  listSessionsReturn = [{ name: "session", windows: [{ index: 0, name: "oracle", active: true }] }];
  resolveTargetReturn = { type: "local", target: "session:oracle.0" };
  findPeerUrl = null;
  getPaneCommandReturn = "claude";
  captureResponses = ["❯ ", "accepted after send"];
  sendKeysCalls = [];
  curlFetchCalls = [];
  curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, target: "receiver.0", lastLine: "ack" } });
  runHookCalls = [];
  logMessageCalls = [];
  emitFeedCalls = [];
  defaultInboxCalls = [];
  defaultInboxResult = null;
  shouldWakeCalls = [];
  shouldWakeReturn = { wake: false };
  shouldWakeError = null;
  scopesMode = "ok";
  trustAddCalls = [];
  trustAddError = null;
  consentDecision = { allow: true };
  tmuxPaneList = "0 claude\n";
  sleepCalls = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
  delete process.env.MAW_CONSENT;
  delete process.env.MAW_ACL_BYPASS;
});

afterEach(() => {
  if (origAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = origAgentName;
  if (origConsent === undefined) delete process.env.MAW_CONSENT;
  else process.env.MAW_CONSENT = origConsent;
  if (origAclBypass === undefined) delete process.env.MAW_ACL_BYPASS;
  else process.env.MAW_ACL_BYPASS = origAclBypass;
});

afterAll(() => {
  (Bun as unknown as { sleep: typeof origSleep }).sleep = origSleep;
  console.error = origErr;
  console.log = origLog;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("comm-send thirteenth-pass helpers", () => {
  test("resolveOraclePane honors explicit panes, single panes, malformed rows, no-agent rows, and tmux failures", async () => {
    expect(await resolveOraclePane("alpha:oracle.2", {
      tmuxRun: async () => { throw new Error("should not inspect explicit panes"); },
    })).toBe("alpha:oracle.2");

    expect(await resolveOraclePane("alpha:single", {
      tmuxRun: async () => "0 bash\n",
      isAgentCommandFn: () => false,
    })).toBe("alpha:single");

    expect(await resolveOraclePane("alpha:multi", {
      tmuxRun: async () => "bad-row\nNaN claude\n2 bash\n5 codex\n1 node\n",
      isAgentCommandFn: (cmd) => cmd === "codex" || cmd === "node",
    })).toBe("alpha:multi.1");

    expect(await resolveOraclePane("alpha:none", {
      tmuxRun: async () => "0 bash\n1 vim\n",
      isAgentCommandFn: () => false,
    })).toBe("alpha:none");

    expect(await resolveOraclePane("alpha:boom", {
      tmuxRun: async () => { throw new Error("tmux unavailable"); },
    })).toBe("alpha:boom");
  });

  test("checkPaneIdle strips ANSI, detects prompt input, treats output and capture errors as idle", async () => {
    await expect(checkPaneIdle("pane", "remote", {
      captureFn: async (target, lines, host) => {
        expect({ target, lines, host }).toEqual({ target: "pane", lines: 5, host: "remote" });
        return "noise\n\x1b[32m❯\x1b[0m deploy now\r";
      },
    })).resolves.toEqual({ idle: false, lastInput: "deploy now" });

    await expect(checkPaneIdle("pane", undefined, {
      captureFn: async () => "agent says hello\nno shell prompt here",
    })).resolves.toEqual({ idle: true, lastInput: "" });

    await expect(checkPaneIdle("pane", undefined, {
      captureFn: async () => { throw new Error("capture failed"); },
    })).resolves.toEqual({ idle: true, lastInput: "" });
  });

  test("message signing and identity helpers cover empty, command, signed, fallback, and env-name paths", () => {
    expect(formatSignedMessage("", { node: "n" }, "me")).toBe("");
    expect(formatSignedMessage("  /wake", { node: "n" }, "me")).toBe("  /wake");
    expect(formatSignedMessage("$plan", { node: "n" }, "me")).toBe("$plan");
    expect(formatSignedMessage("[n:me] already", { node: "n" }, "me")).toBe("[n:me] already");
    expect(formatSignedMessage("  hello", {}, "me")).toBe("  [local:me] hello");

    process.env.CLAUDE_AGENT_NAME = "env-sender";
    expect(resolveMyName({ node: "fallback-node" } as any)).toBe("env-sender");
  });

  test("team workspace resolver handles missing sessions and oracle suffix variants", () => {
    const sessions = [
      { name: "other", windows: [{ name: "neo", index: 0 }] },
      { name: "squad", windows: [{ name: "neo-oracle", index: 1 }, { name: "trinity", index: 2 }] },
    ];

    expect(resolveTeamWorkspaceMemberTarget("missing", "neo", sessions as any)).toBeNull();
    expect(resolveTeamWorkspaceMemberTarget("squad", "neo", sessions as any)).toBe("squad:neo-oracle");
    expect(resolveTeamWorkspaceMemberTarget("squad", "trinity-oracle", sessions as any)).toBe("squad:trinity");
  });
});

describe("comm-send thirteenth-pass cmdSend branches", () => {
  test("cross-node wake success is followed by signed peer delivery", async () => {
    config.namedPeers = [{ name: "remote", url: "http://remote:3456" }];
    resolveTargetReturn = { type: "peer", target: "oracle", node: "remote", peerUrl: "http://remote:3456" };
    shouldWakeReturn = { wake: true };
    curlFetchHandler = (url) => url.endsWith("/api/wake")
      ? { ok: true, status: 200, data: { ok: true } }
      : { ok: true, status: 200, data: { ok: true, state: "queued" } };

    await runCmd(() => cmdSend("remote:oracle", "wake and send", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(shouldWakeCalls[0]).toMatchObject({ target: "oracle", input: { site: "hey", isFleetKnown: true, isLive: false } });
    expect(curlFetchCalls.map((call) => call.url)).toEqual([
      "http://remote:3456/api/wake",
      "http://remote:3456/api/send",
    ]);
    expect(JSON.parse(curlFetchCalls[1].options.body)).toEqual({ target: "oracle", text: "[test-node:sender] wake and send" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "queued", target: "oracle" });
    expect(emitFeedCalls[0].data).not.toHaveProperty("lastLine");
    expect(logs.join("\n")).toContain("remote → oracle");
  });

  test("ACL load failures warn and allow peer delivery", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    scopesMode = "throw";

    await runCmd(() => cmdSend("remote:session:receiver", "deliver despite acl", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(errs.join("\n")).toContain("warn: ACL evaluation failed (scope disk unreadable); allowing send");
    expect(curlFetchCalls).toHaveLength(1);
    expect(logMessageCalls[0]).toMatchObject({ route: "peer:remote", message: "[test-node:sender] deliver despite acl" });
  });

  test("trust persistence failures warn but do not block approved peer sends", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    trustAddError = new Error("trust file locked");

    await runCmd(() => cmdSend("remote:session:receiver", "approved send", false, {
      approve: true,
      trust: true,
      receiverInbox: false,
    }));

    expect(exitCode).toBeUndefined();
    expect(trustAddCalls).toEqual([]);
    expect(errs.join("\n")).toContain("warn: trust persistence failed (trust file locked)");
    expect(curlFetchCalls[0].url).toBe("http://remote:3456/api/send");
  });

  test("force local send skips pane command and idle checks while still writing receiver inbox", async () => {
    resolveTargetReturn = { type: "self-node", target: "session:oracle" };
    tmuxPaneList = "0 bash\n3 node\n1 codex\n";
    getPaneCommandReturn = "vim";
    captureResponses = ["final line after send"];
    defaultInboxResult = { ok: true, oracle: "oracle", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" };

    await runCmd(() => cmdSend("test-node:session:oracle", "forced", true));

    expect(exitCode).toBeUndefined();
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.1", text: "[test-node:sender] forced" }]);
    expect(defaultInboxCalls[0]).toMatchObject({ target: "session:oracle.1", from: "test-node:sender" });
    expect(sleepCalls).toEqual([150]);
    expect(logMessageCalls[0]).toMatchObject({ route: "local" });
    expect(logs.join("\n")).toContain("final line after send");
  });

  test("discovery failure reports remote error and emits failed discovery feed", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: false, status: 503, data: { error: "busy" } });

    await runCmd(() => cmdSend("local:ghost", "hello", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "failed", error: "busy", peerUrl: "http://discovered:3456" });
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://discovered:3456: busy");
  });

  test("final miss can queue to receiver inbox before printing resolver errors", async () => {
    resolveTargetReturn = { type: "error", detail: "not found", hint: "use maw ls" };
    defaultInboxResult = { ok: true, oracle: "ghost", inboxDir: "/tmp/inbox", path: "/tmp/inbox/msg.md", filename: "msg.md" };

    await runCmd(() => cmdSend("local:ghost", "queue fallback"));

    expect(exitCode).toBeUndefined();
    expect(defaultInboxCalls[0]).toMatchObject({ query: "local:ghost", target: undefined, message: "[test-node:sender] queue fallback" });
    expect(logMessageCalls).toEqual([{ from: "sender", to: "local:ghost", message: "[test-node:sender] queue fallback", route: "inbox" }]);
    expect(errs).toEqual([]);
    expect(logs.join("\n")).toContain("target not live; persisted for receiver inbox polling");
  });

  test("local auto-wake helper errors are best-effort and fall through to normal delivery", async () => {
    config.node = "local";
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };
    shouldWakeError = new Error("manifest parser exploded");

    await runCmd(() => cmdSend("local:oracle", "still deliver", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(shouldWakeCalls).toHaveLength(1);
    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[local:sender] still deliver" }]);
    expect(errs).toEqual([]);
  });

  test("local delivery without config.node throws after tmux send instead of logging an invalid feed", async () => {
    config = { oracle: "sender", port: 3456, namedPeers: [] };
    resolveTargetReturn = { type: "local", target: "session:oracle.0" };

    await expect(cmdSend("local:session:oracle", "missing node", false, { receiverInbox: false }))
      .rejects.toThrow("config.node is required");

    expect(sendKeysCalls).toEqual([{ target: "session:oracle.0", text: "[local:sender] missing node" }]);
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:session:oracle", message: "[local:sender] missing node" } }]);
    expect(logMessageCalls).toEqual([]);
  });

  test("peer failures fall back to HTTP status when response data has no error", async () => {
    resolveTargetReturn = { type: "peer", target: "receiver", node: "remote", peerUrl: "http://remote:3456" };
    curlFetchHandler = () => ({ ok: false, status: 502, data: {} });

    await runCmd(() => cmdSend("remote:session:receiver", "bad gateway", false, { receiverInbox: false }));

    expect(exitCode).toBe(1);
    expect(emitFeedCalls[0].data).toMatchObject({ route: "peer", state: "failed", error: "HTTP 502" });
    expect(errs.join("\n")).toContain("Remote fetch failed for peer http://remote:3456 (remote): HTTP 502");
  });

  test("discovery success preserves queued state while falling back to query target and blank last line", async () => {
    resolveTargetReturn = null;
    findPeerUrl = "http://discovered:3456";
    curlFetchHandler = () => ({ ok: true, status: 200, data: { ok: true, state: "queued" } });

    await runCmd(() => cmdSend("local:ghost", "queue remotely", false, { receiverInbox: false }));

    expect(exitCode).toBeUndefined();
    expect(logMessageCalls[0]).toMatchObject({ route: "discovery", message: "[test-node:sender] queue remotely" });
    expect(emitFeedCalls[0].data).toMatchObject({ route: "discovery", state: "queued", target: "local:ghost" });
    expect(emitFeedCalls[0].data).not.toHaveProperty("lastLine");
    expect(runHookCalls).toEqual([{ name: "after_send", payload: { to: "local:ghost", message: "[test-node:sender] queue remotely" } }]);
  });

});
