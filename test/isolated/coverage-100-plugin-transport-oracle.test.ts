import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const created: string[] = [];
function tempDir(prefix = "maw-coverage-plugin-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

async function withCapturedConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe("LoRa stub and transport router coverage", () => {
  test("LoRa remains disconnected, rejects sends, and accepts event handlers", async () => {
    const { LoRaTransport } = await import("../../src/transports/lora.ts");
    const lora = new LoRaTransport();

    expect(lora.name).toBe("lora");
    expect(lora.connected).toBe(false);
    lora.onMessage(() => {});
    lora.onPresence(() => {});
    lora.onFeed(() => {});
    await lora.connect();
    await lora.publishPresence({ oracle: "neo", host: "mesh", status: "ready", timestamp: 1 });
    await lora.publishFeed({ oracle: "neo", event: "Stop", timestamp: new Date(0).toISOString(), ts: 0 } as any);
    expect(await lora.send({ oracle: "neo" }, "hello")).toBe(false);
    expect(lora.canReach({ oracle: "neo" })).toBe(false);
    await lora.disconnect();
    expect(lora.connected).toBe(false);
  });

  test("router failover, event wiring, broadcasts, discovery, and error classification", async () => {
    const { TransportRouter, classifyError } = await import("../../src/core/transport/transport.ts");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const handlers: Record<string, Function[]> = { msg: [], presence: [], feed: [] };
      const calls: string[] = [];
      const makeTransport = (name: string, opts: { connected?: boolean; reachable?: boolean; send?: () => boolean | Promise<boolean>; peers?: unknown[]; throwPeers?: boolean }) => ({
        name,
        connected: opts.connected ?? true,
        connect: async () => { calls.push(`${name}:connect`); },
        disconnect: async () => { calls.push(`${name}:disconnect`); },
        canReach: () => opts.reachable ?? true,
        send: async () => opts.send ? opts.send() : true,
        publishPresence: async () => { calls.push(`${name}:presence`); },
        publishFeed: async () => { calls.push(`${name}:feed`); },
        onMessage: (fn: Function) => handlers.msg.push(fn),
        onPresence: (fn: Function) => handlers.presence.push(fn),
        onFeed: (fn: Function) => handlers.feed.push(fn),
        listPeers: opts.throwPeers ? () => { throw new Error("bad peers"); } : opts.peers ? () => opts.peers! : undefined,
      });

      const router = new TransportRouter();
      router.register(makeTransport("first", { send: () => false, peers: [{ id: 1 }] }) as any);
      router.register(makeTransport("second", { send: () => true }) as any);
      router.register(makeTransport("silent", { connected: false, reachable: true, peers: [{ id: 2 }] }) as any);
      router.register(makeTransport("broken-discovery", { throwPeers: true }) as any);

      const messages: unknown[] = [];
      const presences: unknown[] = [];
      const feeds: unknown[] = [];
      router.onMessage((msg) => messages.push(msg));
      router.onPresence((presence) => presences.push(presence));
      router.onFeed((event) => feeds.push(event));

      handlers.msg[0]!({ body: "hi" });
      handlers.presence[0]!({ oracle: "neo" });
      handlers.feed[0]!({ event: "Stop" });
      expect(messages).toEqual([{ body: "hi" }]);
      expect(presences).toEqual([{ oracle: "neo" }]);
      expect(feeds).toEqual([{ event: "Stop" }]);

      expect(await router.send({ oracle: "neo" }, "hello", "mawjs")).toEqual({ ok: true, via: "second", retryable: false });
      expect(logs.join("\n")).toContain("first: send failed");
      await router.publishPresence({ oracle: "neo", host: "local", status: "idle", timestamp: 1 });
      await router.publishFeed({ oracle: "neo", event: "Stop", timestamp: "now", ts: 1 } as any);
      await router.connectAll();
      await router.disconnectAll();
      expect(calls).toContain("first:presence");
      expect(calls).not.toContain("silent:presence");
      expect(router.status()).toContainEqual({ name: "second", connected: true });
      expect(router.listDiscoveredPeers()).toEqual([{ id: 1 }, { id: 2 }]);

      const authRouter = new TransportRouter();
      authRouter.register(makeTransport("auth", { send: () => { throw new Error("403 forbidden"); } }) as any);
      authRouter.register(makeTransport("never", { send: () => true }) as any);
      expect(await authRouter.send({ oracle: "neo" }, "hello", "mawjs")).toEqual({ ok: false, via: "auth", reason: "auth", retryable: false });

      const retryRouter = new TransportRouter();
      retryRouter.register(makeTransport("timeout", { send: () => { throw new Error("ETIMEDOUT"); } }) as any);
      expect(await retryRouter.send({ oracle: "neo" }, "hello", "mawjs")).toEqual({ ok: false, via: "none", reason: "unreachable", retryable: false });

      expect(classifyError(null)).toEqual({ reason: "unknown", retryable: false });
      expect(classifyError("ECONNREFUSED")).toEqual({ reason: "unreachable", retryable: true });
      expect(classifyError("429 rate limit")).toEqual({ reason: "rate_limit", retryable: true });
      expect(classifyError("400 rejected")).toEqual({ reason: "rejected", retryable: false });
      expect(classifyError("json syntax")).toEqual({ reason: "parse_error", retryable: false });
    } finally {
      console.log = origLog;
    }
  });
});

describe("transport registry and workspace barrel coverage", () => {
  const originalWarn = console.warn;
  let config: any;
  let workspaceConfigs: unknown[];
  const constructed: any[] = [];

  beforeEach(() => {
    config = {
      node: "node-a",
      oracle: "mawjs",
      port: 4567,
      disabledPlugins: [],
      discovery: { transport: "both" },
      agents: { "neo-oracle": {}, helper: {} },
      peers: [{ name: "peer" }],
    };
    workspaceConfigs = [{ id: "workspace" }];
    constructed.length = 0;
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  mock.module(import.meta.resolve("../../src/config"), () => ({
    D: { intervals: {}, timeouts: {}, limits: {} },
    loadConfig: () => config,
    resetConfig: () => {},
    saveConfig: () => {},
    configForDisplay: () => config,
    cfgInterval: () => 1,
    cfgTimeout: () => 1,
    cfgLimit: () => 9999,
    cfg: () => undefined,
    validateConfigShape: () => {},
    buildCommand: (cmd: string) => cmd,
    buildCommandInDir: (_dir: string, cmd: string) => cmd,
    getEnvVars: () => ({}),
  }));
  mock.module(import.meta.resolve("../../src/transports/tmux"), () => ({
    TmuxTransport: class {
      name = "tmux"; connected = true;
      constructor() { constructed.push(["tmux"]); }
      async connect() {}
      async disconnect() {}
      async send() { return true; }
      async publishPresence() {}
      async publishFeed() {}
      onMessage() {}
      onPresence() {}
      onFeed() {}
      canReach() { return true; }
    },
  }));
  mock.module(import.meta.resolve("../../src/transports/http"), () => ({
    HttpTransport: class {
      name = "http"; connected = true;
      constructor(opts: unknown) { constructed.push(["http", opts]); }
      async connect() {}
      async disconnect() {}
      async send() { return true; }
      async publishPresence() {}
      async publishFeed() {}
      onMessage() {}
      onPresence() {}
      onFeed() {}
      canReach() { return true; }
    },
  }));
  mock.module(import.meta.resolve("../../src/transports/hub"), () => ({
    loadWorkspaceConfigs: () => workspaceConfigs,
    HubTransport: class {
      name = "hub"; connected = true;
      constructor(node: string) { constructed.push(["hub", node]); }
      async connect() {}
      async disconnect() {}
      async send() { return true; }
      async publishPresence() {}
      async publishFeed() {}
      onMessage() {}
      onPresence() {}
      onFeed() {}
      canReach() { return true; }
    },
  }));
  mock.module(import.meta.resolve("../../src/transports/nanoclaw"), () => ({
    NanoclawTransport: class { name = "nanoclaw"; connected = false; async connect() {} async disconnect() {} async send() { return false; } async publishPresence() {} async publishFeed() {} onMessage() {} onPresence() {} onFeed() {} canReach() { return false; } },
  }));
  mock.module(import.meta.resolve("../../src/transports/mdns"), () => ({ MdnsTransport: class {} }));
  mock.module(import.meta.resolve("../../src/transports/scout"), () => ({
    ScoutTransport: class {
      name = "scout"; connected = true;
      constructor(opts: unknown) { constructed.push(["scout", opts]); }
      async connect() {}
      async disconnect() {}
      async send() { return true; }
      async publishPresence() {}
      async publishFeed() {}
      onMessage() {}
      onPresence() {}
      onFeed() {}
      canReach() { return true; }
    },
  }));
  mock.module(import.meta.resolve("../../src/transports/zenoh-scout"), () => ({
    ZenohScoutTransport: class {
      name = "zenoh-scout"; connected = true;
      constructor(opts: unknown) { constructed.push(["zenoh-scout", opts]); }
      async connect() {}
      async disconnect() {}
      async send() { return true; }
      async publishPresence() {}
      async publishFeed() {}
      onMessage() {}
      onPresence() {}
      onFeed() {}
      canReach() { return true; }
    },
  }));
  mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/zenoh-scout/impl"), () => ({
    readZenohScoutConfig: () => ({ locator: "tcp/127.0.0.1:7447" }),
  }));

  test("discoveryTransport downgrades unavailable zenoh plugin modes", async () => {
    const mod = await import("../../src/transports/index.ts");
    expect(mod.discoveryTransport({ disabledPlugins: ["zenoh-scout"], discovery: { transport: "zenoh" } } as any)).toBe("off");
    expect(mod.discoveryTransport({ disabledPlugins: ["zenoh-scout"], discovery: { transport: "both" } } as any)).toBe("scout");
    expect(mod.discoveryTransport({ disabledPlugins: ["zenoh-scout"], discovery: { transport: "scout" } } as any)).toBe("scout");
    expect(mod.discoveryTransport({ disabledPlugins: [], discovery: { transport: "off" } } as any)).toBe("off");
    expect(mod.discoveryTransport({ disabledPlugins: [], zenoh: { scout: { enabled: true } } } as any)).toBe("both");
  });

  test("create/get/reset transport router registers configured transports", async () => {
    const mod = await import("../../src/transports/index.ts");
    const router = mod.createTransportRouter();
    expect(mod.getTransportRouter()).toBe(router);
    expect(router.status().map((s: any) => s.name)).toEqual(["tmux", "hub", "scout", "zenoh-scout", "http", "nanoclaw", "lora"]);
    expect(constructed).toContainEqual(["hub", "node-a"]);
    expect(constructed.find((row) => row[0] === "scout")?.[1]).toMatchObject({ node: "node-a", oracle: "mawjs", port: 4567, oracles: ["neo-oracle"], autoPair: true });
    expect(constructed.find((row) => row[0] === "zenoh-scout")?.[1]).toMatchObject({ locator: "tcp/127.0.0.1:7447", enabled: true });
    mod.resetTransportRouter();
    expect(mod.getTransportRouter()).not.toBe(router);
    mod.resetTransportRouter();
  });

  test("workspace barrel exposes route/auth/storage exports", async () => {
    const workspace = await import("../../src/api/workspace.ts");
    expect(workspace.workspaceApi).toBeDefined();
    expect(workspace.WORKSPACE_DIR).toBeString();
    expect(workspace.wsSign).toBeFunction();
    expect(workspace.wsVerify).toBeFunction();
  });
});

describe("registry helper warning and watcher coverage", () => {
  test("warnLegacyOnce persists the throttle state once and pluralizes messages", async () => {
    const dir = tempDir();
    const stateFile = join(dir, "warnings.json");
    const warnings: string[] = [];
    const oldState = process.env.MAW_WARN_STATE_FILE;
    process.env.MAW_WARN_STATE_FILE = stateFile;

    mock.module(import.meta.resolve("../../src/cli/verbosity"), () => ({
      setVerbosityFlags: () => {},
      isSilent: () => false,
      isQuiet: () => false,
      verbose: (fn: () => void) => fn(),
      warn: (msg: string) => warnings.push(msg),
      info: () => {},
      error: () => {},
    }));

    try {
      const mod = await import("../../src/plugin/registry-helpers.ts");
      mod.warnLegacyOnce(2);
      mod.warnLegacyOnce(1);
      expect(warnings).toEqual(["2 legacy plugins loaded without artifact hash — build them to enforce integrity."]);
      expect(JSON.parse(readFileSync(stateFile, "utf8"))["legacy-plugin-warning"].lastShownMs).toBeNumber();
    } finally {
      if (oldState === undefined) delete process.env.MAW_WARN_STATE_FILE;
      else process.env.MAW_WARN_STATE_FILE = oldState;
    }
  });

  test("watchUserPlugins is a noop when disabled or directory is absent, and cleanup tolerates close errors", async () => {
    const oldReload = process.env.MAW_HOT_RELOAD;
    const mod = await import("../../src/plugins/40_watcher.ts");
    try {
      process.env.MAW_HOT_RELOAD = "0";
      expect(() => mod.watchUserPlugins(join(tempDir(), "missing"), () => {})()).not.toThrow();
      delete process.env.MAW_HOT_RELOAD;
      expect(() => mod.watchUserPlugins(join(tempDir(), "missing"), () => {})()).not.toThrow();
    } finally {
      if (oldReload === undefined) delete process.env.MAW_HOT_RELOAD;
      else process.env.MAW_HOT_RELOAD = oldReload;
    }
  });
});

describe("oracle/fleet small-gap pure helper coverage", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    org: "org",
    repo: "repo",
    name: "neo",
    local_path: "",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as any);

  test("prune candidates require no positive lineage/tmux/federation signals and stale scan maps tiers", async () => {
    const prune = await import("../../src/commands/plugins/oracle/impl-prune.ts");
    expect(prune.buildPruneCandidates([
      entry({ name: "empty" }),
      entry({ name: "awake" }),
      entry({ name: "fed", federation_node: "white" }),
      entry({ name: "lineage", has_psi: true }),
    ], new Set(["awake"])).map((c: any) => c.entry.name)).toEqual(["empty"]);

    expect(prune.buildStaleCandidates([
      { ...entry({ name: "active" }), tier: "ACTIVE", recommendation: "recent", awake: false },
      { ...entry({ name: "stale" }), tier: "STALE", recommendation: "investigate", awake: false },
      { ...entry({ name: "dead", has_psi: true }), tier: "DEAD", recommendation: "archive", awake: true },
    ] as any).map((c: any) => [c.entry.name, c.reasons, c.tier])).toEqual([
      ["stale", ["STALE (30-90d)", "investigate", "no tmux"], "STALE"],
      ["dead", ["DEAD (>90d)", "archive"], "DEAD"],
    ]);

    const writes: any[] = [];
    const { result: confirmed, logs } = await withCapturedConsole(() => prune.cmdOraclePrune({ force: true }, {
      listAwake: async () => new Set(),
      readRawCache: () => ({ oracles: [entry({ name: "empty" })], retired: [entry({ name: "old" })] }),
      writeRawCache: (data: any) => writes.push(data),
      promptConfirm: async () => true,
    }));
    expect(confirmed).toBeUndefined();
    expect(logs.join("\n")).toContain("Retired 1 oracle");
    expect(writes[0].oracles).toEqual([]);
    expect(writes[0].retired.map((e: any) => e.name)).toEqual(["old", "empty"]);
  });

  test("register discovers in injected source priority and raw registry helpers tolerate bad input", async () => {
    const reg = await import("../../src/commands/plugins/oracle/impl-register.ts");
    const dir = tempDir();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not-json");
    expect(reg.readRawRegistry(bad)).toEqual({});
    const out = join(dir, "out.json");
    reg.writeRawRegistry(out, { ok: true });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ ok: true });

    const writes: any[] = [];
    const { logs } = await withCapturedConsole(() => reg.cmdOracleRegister("neo", { json: true }, {
      readRawCache: () => ({ oracles: [] }),
      writeRawCache: (data: any) => writes.push(data),
      findInFleetFn: () => null,
      findInTmuxFn: async () => ({ source: "tmux", entry: entry({ name: "neo", repo: "neo-oracle" }) }),
      findInFilesystemFn: () => { throw new Error("filesystem should not be reached"); },
    }));
    expect(logs.join("\n")).toContain('"source": "tmux"');
    expect(writes[0].oracles[0]).toMatchObject({ name: "neo", repo: "neo-oracle" });

    await expect(reg.cmdOracleRegister("neo", {}, {
      readRawCache: () => ({ oracles: [entry({ name: "neo", org: "org" })] }),
      writeRawCache: () => {},
    })).rejects.toThrow("already registered");
  });

  test("stale classifier covers awake, no commit, tier boundaries, sorting, and scan filtering", async () => {
    const stale = await import("../../src/commands/plugins/oracle/impl-stale.ts");
    const now = new Date("2026-05-18T00:00:00.000Z");
    expect(stale.classifyStaleness({ entry: entry({ local_path: "" }), lastCommitISO: null, awake: false, now }).tier).toBe("DEAD");
    expect(stale.classifyStaleness({ entry: entry(), lastCommitISO: "2026-05-17T00:00:00.000Z", awake: true, now }).recommendation).toBe("awake in tmux");
    expect(stale.classifyStaleness({ entry: entry(), lastCommitISO: "2026-05-10T00:00:00.000Z", awake: false, now }).tier).toBe("SLOW");
    expect(stale.classifyStaleness({ entry: entry(), lastCommitISO: "2026-04-10T00:00:00.000Z", awake: false, now }).tier).toBe("STALE");

    const sorted = stale.sortByStaleness([
      { name: "b", tier: "ACTIVE", days_since_commit: 1 },
      { name: "a", tier: "DEAD", days_since_commit: null },
      { name: "c", tier: "STALE", days_since_commit: 40 },
      { name: "d", tier: "STALE", days_since_commit: 80 },
    ] as any);
    expect(sorted.map((e: any) => e.name)).toEqual(["a", "d", "c", "b"]);

    const scan = await stale.runStaleScan({}, {
      readEntries: () => [entry({ name: "fresh", local_path: "fresh" }), entry({ name: "dead", local_path: "dead" })],
      listAwake: async () => new Set(),
      getLastCommit: (path: string) => path === "fresh" ? "2026-05-17T00:00:00.000Z" : null,
      now: () => now,
    });
    expect(scan.map((e: any) => e.name)).toEqual(["dead"]);
  });

  test("snapshot lists corrupt files, loads partial timestamp matches, and returns null for missing/bad snapshots", async () => {
    const snapDir = tempDir("maw-snapshots-");
    mock.module(import.meta.resolve("../../src/core/paths"), () => ({ CONFIG_DIR: snapDir }));
    mock.module(import.meta.resolve("../../src/core/transport/ssh"), () => ({
      listSessions: async () => [{ name: "main", windows: [{ name: "neo-oracle" }, { name: "pulse-oracle" }] }],
    }));
    mock.module(import.meta.resolve("../../src/config"), () => ({ loadConfig: () => ({ node: "node-a" }) }));

    const mod = await import("../../src/core/fleet/snapshot.ts?coverage-100-plugin-snapshot");
    const file = await mod.takeSnapshot("manual");
    expect(existsSync(file)).toBe(true);
    writeFileSync(join(mod.SNAPSHOT_DIR, "99999999-999999.json"), "not-json");
    const rows = mod.listSnapshots();
    expect(rows[0]).toMatchObject({ file: "99999999-999999.json", timestamp: "?", trigger: "?", sessionCount: 0, windowCount: 0 });
    expect(rows.find((row: any) => row.file === file.split("/").pop())).toMatchObject({ trigger: "manual", sessionCount: 1, windowCount: 2 });
    expect(mod.loadSnapshot(file.split("/").pop()!.replace(/\.json$/, ""))).toMatchObject({ trigger: "manual", node: "node-a" });
    expect(mod.loadSnapshot("missing")).toBeNull();
    expect(mod.latestSnapshot()).toBeNull();
  });
});

describe("tmux pane lock small helper", () => {
  test("splitWindowLocked builds tmux arguments for horizontal, vertical, pct, command, and no-settle", async () => {
    const { splitWindowLocked } = await import("../../src/core/transport/tmux-pane-lock.ts");
    const calls: unknown[][] = [];
    const fakeTmux = { run: async (...args: unknown[]) => { calls.push(args); } };
    await splitWindowLocked("main:0", { tmux: fakeTmux as any, settleMs: 0 });
    await splitWindowLocked("main:1", { tmux: fakeTmux as any, vertical: true, pct: 33, shellCommand: "zsh", settleMs: 0 });
    await splitWindowLocked("main:2", { tmux: fakeTmux as any, vertical: false, pct: 20, settleMs: 0 });
    expect(calls).toEqual([
      ["split-window", "-t", "main:0"],
      ["split-window", "-t", "main:1", "-v", "-l", "33%", "zsh"],
      ["split-window", "-t", "main:2", "-h", "-l", "20%"],
    ]);
  });
});
