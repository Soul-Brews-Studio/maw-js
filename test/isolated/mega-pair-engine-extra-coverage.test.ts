import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockSshModule } from "../helpers/mock-ssh";

let megaStatusCalls = 0;
let megaStopCalls = 0;
let megaStopError: Error | null = null;

mock.module("../../src/vendor/mpr-plugins/mega/impl", () => ({
  cmdMegaStatus: async () => {
    megaStatusCalls += 1;
    console.log("mega status called");
  },
  cmdMegaStop: async () => {
    megaStopCalls += 1;
    console.error("mega stop called");
    if (megaStopError) throw megaStopError;
  },
}));

let tmuxListAllError: Error | null = null;
let tmuxSessions: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let registeredTypes: string[] = [];
let startCalls = 0;
let stopCalls = 0;
let sendInitialCalls = 0;
let pushCaptureCalls = 0;
let pushPreviewsCalls = 0;
let crashCalls = 0;
let sentKeys: Array<{ target: string; body: string }> = [];
let sshSessions: typeof tmuxSessions = [];
let findWindowCalls: string[] = [];

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
    registeredTypes.push("coverage-handler");
    engine.on("coverage-handler", (ws: { send: (message: string) => void }, data: Record<string, unknown>) => {
      ws.send(JSON.stringify({ type: "handled", payload: data.payload }));
    });
  },
}));

mock.module("../../src/config", () => ({
  cfgLimit: (key: string) => {
    expect(key).toBe("feedHistory");
    return 2;
  },
}));

mock.module("../../src/engine/engine-intervals", () => ({
  startIntervals: (state: Record<string, unknown>, onCrash: () => Promise<void>) => {
    startCalls += 1;
    state.captureInterval = { id: `capture-${startCalls}` };
    state.sessionInterval = { id: `session-${startCalls}` };
    state.previewInterval = { id: `preview-${startCalls}` };
    state.statusInterval = { id: `status-${startCalls}` };
    state.teamsInterval = { id: `teams-${startCalls}` };
    state.peerInterval = { id: `peer-${startCalls}` };
    state.crashCheckInterval = { id: `crash-${startCalls}` };
    state.peerSessionsCache = [{ name: "peer-session", windows: [], source: "peer" }];
    state.feedUnsub = () => { /* covered by stopIntervals */ };
    void onCrash;
  },
  stopIntervals: (state: Record<string, unknown>) => {
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
    ws.send(JSON.stringify({ type: "sessions", sessions: state.sessionCache.sessions }));
  },
}));

mock.module("../../src/engine/capture", () => ({
  sendBusyAgents: async () => {},
  pushCapture: async (ws: { send: (message: string) => void }, lastContent: Map<unknown, string>) => {
    pushCaptureCalls += 1;
    lastContent.set(ws, "captured");
    return "capture-result";
  },
  pushPreviews: async (ws: { send: (message: string) => void }, lastPreviews: Map<unknown, Map<string, string>>) => {
    pushPreviewsCalls += 1;
    lastPreviews.set(ws, new Map([["pane", "preview"]]));
    return "preview-result";
  },
}));

mock.module("../../src/engine/engine-crash", () => ({
  handleCrashedAgents: async () => {
    crashCalls += 1;
  },
}));

mock.module("../../src/core/transport/peers", () => ({
  getPeers: () => [],
  getAggregatedSessions: async (sessions: unknown[]) => sessions,
}));

mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({
    listSessions: async () => sshSessions,
    findWindow: (sessions: typeof tmuxSessions, name: string) => {
      findWindowCalls.push(name);
      for (const session of sessions) {
        const found = session.windows.find((window) => window.name === name);
        if (found) return `${session.name}:${found.index}`;
      }
      return null;
    },
    sendKeys: async (target: string, body: string) => {
      sentKeys.push({ target, body });
    },
  }),
);

const megaHandler = (await import("../../src/vendor/mpr-plugins/mega/index")).default;
const pairCodes = await import("../../src/vendor/mpr-plugins/pair/codes");
const { MawEngine } = await import("../../src/engine");

const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
};

function makeWs() {
  const messages: any[] = [];
  const ws = {
    data: { target: null, previewTargets: new Set<string>() },
    send: (message: string) => {
      messages.push(JSON.parse(message));
    },
  };
  return { ws, messages };
}

function makeEngine(feedBuffer = [{ type: "old" }, { type: "newer" }, { type: "newest" }] as any[]) {
  return new MawEngine({ feedBuffer, feedListeners: new Set() });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  megaStatusCalls = 0;
  megaStopCalls = 0;
  megaStopError = null;
  tmuxListAllError = null;
  tmuxSessions = [{ name: "local", windows: [{ index: 1, name: "pulse", active: true }] }];
  registeredTypes = [];
  startCalls = 0;
  stopCalls = 0;
  sendInitialCalls = 0;
  pushCaptureCalls = 0;
  pushPreviewsCalls = 0;
  crashCalls = 0;
  sentKeys = [];
  sshSessions = [];
  findWindowCalls = [];
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  pairCodes._resetStore();
});

afterEach(() => {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  pairCodes._resetStore();
});

describe("mega plugin index extra coverage", () => {
  test("prints help for unknown CLI subcommands into buffered output", async () => {
    const result = await megaHandler({ source: "cli", args: ["wat"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw mega — MegaAgent hierarchical multi-agent system");
    expect(result.output).toContain("maw mega status       Same as above");
    expect(result.output).toContain("maw mega stop         Kill all active team panes");
    expect(megaStatusCalls).toBe(0);
    expect(megaStopCalls).toBe(0);
  });

  test("uses writer output for API callers and does not treat API args as CLI subcommands", async () => {
    const written: string[] = [];
    const result = await megaHandler({
      source: "api",
      args: ["stop"],
      writer: (...args: unknown[]) => written.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(written).toEqual(["mega status called"]);
    expect(megaStatusCalls).toBe(1);
    expect(megaStopCalls).toBe(0);
  });

  test("returns logged output as error when a CLI branch throws", async () => {
    megaStopError = new Error("boom after log");

    const result = await megaHandler({ source: "cli", args: ["kill"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("mega stop called");
    expect(result.output).toBe("mega stop called");
    expect(megaStopCalls).toBe(1);
  });
});

describe("pair code helpers extra coverage", () => {
  test("formats and redacts normalized, short, and non-six-character values", () => {
    expect(pairCodes.normalize("ab c-def")).toBe("ABCDEF");
    expect(pairCodes.pretty("ab c-def")).toBe("ABC-DEF");
    expect(pairCodes.pretty("xy")).toBe("XY");
    expect(pairCodes.redact("ab c-def")).toBe("ABC-***");
    expect(pairCodes.redact("xy")).toBe("***");
  });

  test("validates alphabet shape and maps generated bytes through the reduced alphabet", () => {
    const originalGetRandomValues = crypto.getRandomValues;
    crypto.getRandomValues = ((array: Uint8Array) => {
      array.set([0, 1, 31, 32, 33, 63]);
      return array;
    }) as typeof crypto.getRandomValues;
    try {
      expect(pairCodes.generateCode()).toBe("AB9AB9");
    } finally {
      crypto.getRandomValues = originalGetRandomValues;
    }

    expect(pairCodes.isValidShape("AB9-AB9")).toBe(true);
    expect(pairCodes.isValidShape("AB9-AB0")).toBe(false);
    expect(pairCodes.isValidShape("AB9")).toBe(false);
  });

  test("registers, consumes once, reports expired and not-found lookup states", () => {
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      const entry = pairCodes.register("abc-def", 50);
      expect(entry).toMatchObject({ code: "ABCDEF", expiresAt: 1_050, consumed: false, createdAt: 1_000 });
      expect(pairCodes.lookup("ABC-DEF")).toEqual({ ok: true, entry });
      expect(pairCodes.consume("ABCDEF")).toEqual({ ok: true, entry });
      expect(pairCodes.consume("ABCDEF")).toEqual({ ok: false, reason: "consumed" });

      pairCodes._inject({ code: "GHJKLM", expiresAt: 999, consumed: false, createdAt: 900 });
      expect(pairCodes.lookup("GHJ-KLM")).toEqual({ ok: false, reason: "expired" });
      expect(pairCodes.consume("ZZZ999")).toEqual({ ok: false, reason: "not_found" });
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("MawEngine index extra coverage", () => {
  test("initializes session cache, opens/closes sockets, handles messages, and delegates capture helpers", async () => {
    const engine = makeEngine();
    await flush();

    expect(registeredTypes).toEqual(["coverage-handler"]);
    expect((engine as any).sessionCache.sessions).toEqual(tmuxSessions);
    expect((engine as any).teamsInterval).toEqual({ id: "teams-1" });

    const { ws, messages } = makeWs();
    engine.handleOpen(ws as any);
    await flush();

    expect(sendInitialCalls).toBe(1);
    expect(messages).toContainEqual({ type: "sessions", sessions: tmuxSessions });
    expect(messages).toContainEqual({ type: "feed-history", events: [{ type: "newer" }, { type: "newest" }] });
    expect((engine as any).teamsInterval).toEqual({ id: "teams-2" });

    engine.handleMessage(ws as any, JSON.stringify({ type: "coverage-handler", payload: 42 }));
    expect(messages).toContainEqual({ type: "handled", payload: 42 });

    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    engine.handleMessage(ws as any, "not json");
    expect(errors.join("\n")).toContain("[engine] handleMessage error:");

    await expect(engine.pushCapture(ws as any)).resolves.toBe("capture-result");
    await expect(engine.pushPreviews(ws as any)).resolves.toBe("preview-result");
    expect(pushCaptureCalls).toBe(1);
    expect(pushPreviewsCalls).toBe(1);

    engine.handleClose(ws as any);
    expect(stopCalls).toBe(1);
    expect((engine as any).teamsInterval).toBeNull();
  });

  test("warns on cache init failure and still starts intervals", async () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    tmuxListAllError = new Error("tmux unavailable");

    const engine = makeEngine([]);
    await flush();

    expect(warnings).toEqual(["[engine] session cache init failed — will retry on first WS connect"]);
    expect((engine as any).sessionCache.sessions).toEqual([]);
    expect(startCalls).toBe(1);
  });

  test("routes transport messages using cache, base-name fallback, listSessions fallback, and feed publishing", async () => {
    const engine = makeEngine([]);
    await flush();
    (engine as any).sessionCache = {
      sessions: [{ name: "local", windows: [{ index: 3, name: "neo", active: true }] }],
      json: "",
    };

    const published: unknown[] = [];
    let onMessage: ((msg: any) => void | Promise<void>) | null = null;
    const router = {
      onMessage: (handler: typeof onMessage) => { onMessage = handler; },
      publishFeed: async (event: unknown) => {
        published.push(event);
        throw new Error("publish failure is swallowed");
      },
    };

    engine.setTransportRouter(router as any);
    expect(onMessage).toBeTruthy();

    await onMessage!({ to: "neo-oracle", body: "hello", transport: "test", from: "remote" });
    expect(findWindowCalls).toEqual(["neo-oracle", "neo"]);
    expect(sentKeys).toEqual([{ target: "local:3", body: "hello" }]);

    findWindowCalls = [];
    sentKeys = [];
    (engine as any).sessionCache = { sessions: [], json: "" };
    sshSessions = [{ name: "fallback", windows: [{ index: 7, name: "pulse", active: false }] }];
    await onMessage!({ to: "missing-oracle", body: "ignored", transport: "test", from: "remote" });
    expect(findWindowCalls).toEqual(["missing-oracle", "missing"]);
    expect(sentKeys).toEqual([]);

    const listeners = (engine as any).feedListeners as Set<(event: unknown) => void>;
    listeners.forEach((listener) => listener({ type: "feed-event" }));
    await flush();
    expect(published).toEqual([{ type: "feed-event" }]);
  });

  test("private crash handler delegates with current engine state", async () => {
    const engine = makeEngine([]);
    await flush();

    await (engine as any).handleCrashedAgents();

    expect(crashCalls).toBe(1);
  });
});
