import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let tmuxListAllError: Error | null = null;
let tmuxSessions: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let registeredHandlers: string[] = [];
let startCalls = 0;
let stopCalls = 0;
let sendInitialCalls = 0;
let pushCaptureCalls = 0;
let pushPreviewsCalls = 0;
let crashCalls = 0;
let onCrashCallbacks: Array<() => Promise<void> | void> = [];
let sshSessions: typeof tmuxSessions = [];
let listSessionsError: Error | null = null;
let sendInitialError: Error | null = null;
let sentKeys: Array<{ target: string; body: string }> = [];
let findWindowLookups: string[] = [];

mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    listAll: async () => {
      if (tmuxListAllError) throw tmuxListAllError;
      return tmuxSessions;
    },
  },
}));

mock.module("../../src/core/runtime/handlers", () => ({
  registerBuiltinHandlers: (engine: { on: (type: string, handler: (...args: any[]) => void) => void }) => {
    registeredHandlers.push("extra");
    engine.on("extra", (ws: { send: (message: string) => void }, data: { payload?: unknown }) => {
      ws.send(JSON.stringify({ type: "extra-ok", payload: data.payload }));
    });
  },
}));

mock.module("../../src/config", () => ({
  cfgLimit: (key: string) => {
    expect(key).toBe("feedHistory");
    return 1;
  },
}));

mock.module("../../src/engine/engine-intervals", () => ({
  startIntervals: (state: Record<string, any>, onCrash: () => Promise<void> | void) => {
    startCalls += 1;
    onCrashCallbacks.push(onCrash);
    state.captureInterval = { id: `capture-${startCalls}` };
    state.sessionInterval = { id: `session-${startCalls}` };
    state.previewInterval = { id: `preview-${startCalls}` };
    state.statusInterval = { id: `status-${startCalls}` };
    state.teamsInterval = { id: `teams-${startCalls}` };
    state.peerInterval = { id: `peer-${startCalls}` };
    state.crashCheckInterval = { id: `crash-${startCalls}` };
    state.peerSessionsCache = [{ name: "remote", windows: [], source: "peer" }];
    state.feedUnsub = () => undefined;
  },
  stopIntervals: (state: Record<string, any>) => {
    stopCalls += 1;
    state.captureInterval = null;
    state.sessionInterval = null;
    state.previewInterval = null;
    state.statusInterval = null;
    state.teamsInterval = null;
    state.peerInterval = null;
    state.crashCheckInterval = null;
    state.feedUnsub = null;
  },
  sendInitialSessions: async (ws: { send: (message: string) => void }, state: { sessionCache: { sessions: unknown[] } }) => {
    sendInitialCalls += 1;
    if (sendInitialError) throw sendInitialError;
    ws.send(JSON.stringify({ type: "sessions", sessions: state.sessionCache.sessions }));
  },
}));

mock.module("../../src/engine/capture", () => ({
  sendBusyAgents: () => undefined,
  pushCapture: async (ws: unknown, lastContent: Map<unknown, string>) => {
    pushCaptureCalls += 1;
    lastContent.set(ws, "capture");
    return "capture-result";
  },
  pushPreviews: async (ws: unknown, lastPreviews: Map<unknown, Map<string, string>>) => {
    pushPreviewsCalls += 1;
    lastPreviews.set(ws, new Map([["%1", "preview"]]));
    return "preview-result";
  },
}));

mock.module("../../src/engine/engine-crash", () => ({
  handleCrashedAgents: async () => {
    crashCalls += 1;
  },
}));

mock.module("../../src/engine/status", () => ({
  StatusDetector: class {
    detectCalls: unknown[] = [];
    async detect(...args: unknown[]) { this.detectCalls.push(args); }
    getStatus(target: string) { return target === "local:1" ? "ready" : null; }
  },
}));

mock.module("../../src/core/transport/peers", () => ({
  getPeers: () => [],
  getAggregatedSessions: async (sessions: unknown[]) => sessions,
}));

mock.module("../../src/core/transport/ssh", () => ({
  listSessions: async () => {
    if (listSessionsError) throw listSessionsError;
    return sshSessions;
  },
  findWindow: (sessions: typeof tmuxSessions, name: string) => {
    findWindowLookups.push(name);
    for (const session of sessions) {
      const found = session.windows.find((window) => window.name === name);
      if (found) return `${session.name}:${found.index}`;
    }
    return null;
  },
  sendKeys: async (target: string, body: string) => {
    sentKeys.push({ target, body });
  },
}));

const { MawEngine } = await import("../../src/engine/index.ts?engine-index-extra-coverage");

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

function makeWs() {
  const messages: unknown[] = [];
  return {
    ws: {
      send: (message: string) => messages.push(JSON.parse(message)),
    } as any,
    messages,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  tmuxListAllError = null;
  tmuxSessions = [{ name: "local", windows: [{ index: 1, name: "pulse-oracle", active: true }] }];
  registeredHandlers = [];
  startCalls = 0;
  stopCalls = 0;
  sendInitialCalls = 0;
  pushCaptureCalls = 0;
  pushPreviewsCalls = 0;
  crashCalls = 0;
  onCrashCallbacks = [];
  sshSessions = tmuxSessions;
  listSessionsError = null;
  sendInitialError = null;
  sentKeys = [];
  findWindowLookups = [];
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
});

afterEach(() => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
});

describe("MawEngine index extra coverage", () => {
  test("constructor success path, websocket lifecycle, handler dispatch, push delegates, and crash callback", async () => {
    const feedListeners = new Set<(event: any) => void>();
    const engine = new MawEngine({ feedBuffer: [{ id: "old" }, { id: "new" }] as any[], feedListeners });
    await flush();

    expect(registeredHandlers).toEqual(["extra"]);
    expect(startCalls).toBeGreaterThanOrEqual(1);

    const { ws, messages } = makeWs();
    engine.handleOpen(ws);
    await flush();

    expect(sendInitialCalls).toBe(1);
    expect(messages).toContainEqual({ type: "feed-history", events: [{ id: "new" }] });

    engine.handleMessage(ws, JSON.stringify({ type: "extra", payload: 42 }));
    expect(messages).toContainEqual({ type: "extra-ok", payload: 42 });

    engine.handleMessage(ws, "not json");
    expect(await engine.pushCapture(ws)).toBe("capture-result");
    expect(await engine.pushPreviews(ws)).toBe("preview-result");
    expect(pushCaptureCalls).toBe(1);
    expect(pushPreviewsCalls).toBe(1);

    await onCrashCallbacks.at(-1)?.();
    expect(crashCalls).toBe(1);

    engine.handleClose(ws);
    expect(stopCalls).toBe(1);
  });

  test("transport router routes exact/base names, publishes feed, and logs missing targets", async () => {
    tmuxSessions = [{
      name: "local",
      windows: [
        { index: 1, name: "pulse-oracle", active: true },
        { index: 2, name: "buddy", active: false },
      ],
    }];
    sshSessions = tmuxSessions;
    const feedListeners = new Set<(event: any) => void>();
    const engine = new MawEngine({ feedBuffer: [], feedListeners });
    await flush();

    const feedEvents: unknown[] = [];
    let remoteHandler: ((msg: { to: string; from: string; body: string; transport: string }) => Promise<void>) | undefined;
    const router = {
      onMessage: (handler: typeof remoteHandler) => { remoteHandler = handler; },
      publishFeed: async (event: unknown) => { feedEvents.push(event); },
    } as any;

    engine.setTransportRouter(router);

    await remoteHandler?.({ to: "pulse-oracle", from: "mba", body: "hello", transport: "mqtt" });
    await remoteHandler?.({ to: "buddy-oracle", from: "mba", body: "base", transport: "mqtt" });
    await remoteHandler?.({ to: "missing-oracle", from: "mba", body: "lost", transport: "mqtt" });

    expect(findWindowLookups).toEqual(["pulse-oracle", "buddy-oracle", "buddy", "missing-oracle", "missing"]);
    expect(sentKeys).toEqual([
      { target: "local:1", body: "hello" },
      { target: "local:2", body: "base" },
    ]);

    for (const listener of feedListeners) listener({ type: "note" });
    expect(feedEvents).toEqual([{ type: "note" }]);
  });

  test("transport router and websocket open swallow async fallback rejections", async () => {
    tmuxSessions = [];
    sshSessions = [];
    listSessionsError = new Error("ssh list failed");
    const feedListeners = new Set<(event: any) => void>();
    const engine = new MawEngine({ feedBuffer: [{ id: "old" }, { id: "new" }] as any[], feedListeners });
    await flush();

    let remoteHandler: ((msg: { to: string; from: string; body: string; transport: string }) => Promise<void>) | undefined;
    let publishFeedCalls = 0;
    const router = {
      onMessage: (handler: typeof remoteHandler) => { remoteHandler = handler; },
      publishFeed: async () => {
        publishFeedCalls += 1;
        throw new Error("feed publish failed");
      },
    } as any;
    engine.setTransportRouter(router);

    await remoteHandler?.({ to: "missing-oracle", from: "mba", body: "lost", transport: "mqtt" });
    expect(sentKeys).toEqual([]);

    for (const listener of feedListeners) listener({ type: "note" });
    await flush();
    expect(publishFeedCalls).toBe(1);

    sendInitialError = new Error("initial send failed");
    const { ws, messages } = makeWs();
    engine.handleOpen(ws);
    await flush();
    expect(sendInitialCalls).toBeGreaterThanOrEqual(1);
    expect(messages).toContainEqual({ type: "feed-history", events: [{ id: "new" }] });
  });

  test("constructor warning path still starts intervals after tmux cache init fails", async () => {
    const warnings: string[] = [];
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    tmuxListAllError = new Error("tmux down");

    new MawEngine({ feedBuffer: [], feedListeners: new Set() });
    await flush();

    expect(warnings.join("\n")).toContain("session cache init failed");
    expect(startCalls).toBeGreaterThanOrEqual(1);
  });
});
