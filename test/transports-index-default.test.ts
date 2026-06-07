/**
 * Default-suite coverage for src/transports/index.ts.
 *
 * These mocks are gated to this file's imports and avoid real transport/network
 * work while exercising router construction, singleton reuse, and reset cleanup.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

type FakeTransport = {
  name: string;
  options?: unknown;
  connect: ReturnType<typeof mock>;
  disconnect: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  publishPresence: ReturnType<typeof mock>;
  publishFeed: ReturnType<typeof mock>;
  onMessage: ReturnType<typeof mock>;
  onPresence: ReturnType<typeof mock>;
  onFeed: ReturnType<typeof mock>;
  canReach: ReturnType<typeof mock>;
  connected: boolean;
};

const defaultConfig = {
  node: "test-node",
  oracle: "test-oracle",
  port: 3456,
  agents: {},
  peers: [],
  discovery: { transport: "off" },
  disabledPlugins: [],
};

let configValue: any = { ...defaultConfig };
let loadConfigCalls = 0;
let zenohScoutFactoryCalls: any[] = [];
let zenohConnectReject: unknown = null;
let connectRejectByName = new Map<string, unknown>();
let disconnectAllReject: unknown = null;
let transportInstances: FakeTransport[] = [];
let routerInstances: FakeRouter[] = [];
let routerConstructorArgs: unknown[][] = [];

function makeTransport(name: string, options?: unknown): FakeTransport {
  const transport: FakeTransport = {
    name,
    options,
    connect: mock(async () => {
      if (connectRejectByName.has(name)) throw connectRejectByName.get(name);
      return undefined;
    }),
    disconnect: mock(async () => undefined),
    send: mock(async () => true),
    publishPresence: mock(async () => undefined),
    publishFeed: mock(async () => undefined),
    onMessage: mock(() => undefined),
    onPresence: mock(() => undefined),
    onFeed: mock(() => undefined),
    canReach: mock(() => false),
    connected: true,
  };
  transportInstances.push(transport);
  return transport;
}

class FakeRouter {
  registered: FakeTransport[] = [];
  register = mock((transport: FakeTransport) => {
    this.registered.push(transport);
    transport.onMessage?.mock?.calls?.length;
    transport.onPresence?.mock?.calls?.length;
    transport.onFeed?.mock?.calls?.length;
  });
  disconnectAll = mock(async () => {
    if (disconnectAllReject) throw disconnectAllReject;
    await Promise.all(this.registered.map((transport) => transport.disconnect()));
  });

  constructor(...args: unknown[]) {
    routerConstructorArgs.push(args);
    routerInstances.push(this);
  }
}

mock.module(join(import.meta.dir, "../src/config"), () => ({ // mock-boundary-ok: requested default-suite coverage for transport registry with gated config stub
  loadConfig: () => {
    loadConfigCalls += 1;
    return configValue;
  },
}));

mock.module(join(import.meta.dir, "../src/core/transport/transport"), () => ({ // mock-boundary-ok: requested default-suite coverage for router registration/reset behavior
  TransportRouter: FakeRouter,
}));

mock.module(join(import.meta.dir, "../src/transports/tmux"), () => ({ // mock-boundary-ok: requested default-suite coverage for transport class wiring
  TmuxTransport: class {
    constructor() { return makeTransport("tmux"); }
  },
}));


mock.module(join(import.meta.dir, "../src/transports/http"), () => ({ // mock-boundary-ok: requested default-suite coverage for transport class wiring
  HttpTransport: class {
    constructor(options: unknown) { return makeTransport("http", options); }
  },
}));


mock.module(join(import.meta.dir, "../src/transports/nanoclaw"), () => ({ // mock-boundary-ok: requested default-suite coverage for transport class wiring
  NanoclawTransport: class {
    constructor() { return makeTransport("nanoclaw"); }
  },
}));


mock.module(join(import.meta.dir, "../src/transports/scout"), () => ({ // mock-boundary-ok: requested default-suite coverage for discovery transport wiring
  ScoutTransport: class {
    constructor(options: unknown) { return makeTransport("scout", options); }
  },
}));

function zenohModuleMock() {
  return {
    ZenohTransport: class {
      constructor(options: unknown) {
        const transport = makeTransport("zenoh", options);
        transport.connect = mock(async () => {
          if (zenohConnectReject) throw zenohConnectReject;
          return undefined;
        });
        return transport;
      }
    },
  };
}

mock.module(join(import.meta.dir, "../src/transports/zenoh"), zenohModuleMock); // mock-boundary-ok: requested default-suite coverage for dynamic zenoh transport import wiring
mock.module(join(import.meta.dir, "../src/transports/zenoh.ts"), zenohModuleMock); // mock-boundary-ok: requested default-suite coverage for dynamic zenoh transport import wiring

mock.module(join(import.meta.dir, "../src/plugin/registry"), () => ({ // mock-boundary-ok: requested default-suite coverage for plugin transport wiring
  importPluginSymbol: async (_plugin: string, _symbol: string) => (config: unknown) => {
    zenohScoutFactoryCalls.push(config);
    return makeTransport("zenoh-scout", { locator: "tcp/127.0.0.1:7447", fromPluginConfig: true });
  },
}));

async function waitForAsyncTransportWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

const {
  createTransportRouter,
  discoveryTransport,
  getTransportRouter,
  resetTransportRouter,
} = await import("../src/transports/index");

beforeEach(() => {
  resetTransportRouter();
  configValue = { ...defaultConfig, discovery: { transport: "off" }, disabledPlugins: [], agents: {}, peers: [] };
  loadConfigCalls = 0;
  zenohScoutFactoryCalls = [];
  zenohConnectReject = null;
  connectRejectByName = new Map();
  disconnectAllReject = null;
  transportInstances = [];
  routerInstances = [];
  routerConstructorArgs = [];
});

afterEach(() => {
  resetTransportRouter();
});

describe("transport registry default coverage", () => {
  test("creates the minimum router once and reuses it through create/get", () => {
    const router = createTransportRouter() as unknown as FakeRouter;
    const sameFromCreate = createTransportRouter();
    const sameFromGet = getTransportRouter();

    expect(sameFromCreate).toBe(router);
    expect(sameFromGet).toBe(router);
    expect(loadConfigCalls).toBe(1);
    expect(routerConstructorArgs).toEqual([[[]]]);
    expect(router.registered.map((transport) => transport.name)).toEqual(["tmux", "nanoclaw"]);
    expect(transportInstances.find((transport) => transport.name === "tmux")?.connect).toHaveBeenCalledTimes(1);
    expect(transportInstances.filter((transport) => transport.name !== "tmux").every((transport) => transport.connect.mock.calls.length === 0)).toBe(true);
  });

  test("registers discovery and peer transports with expected options", async () => {
    configValue = {
      ...defaultConfig,
      node: "m5",
      oracle: "mawjs-oracle",
      port: 4567,
      agents: {
        "mawjs-oracle": {},
        "pulse-oracle": {},
        helper: {},
      },
      peers: [{ name: "white", url: "http://white.local:3456" }],
      discovery: { transport: "both" },
      zenoh: { scout: { enabled: true } },
      broadcastTo: ["nanoclaw"],
    };

    const router = createTransportRouter() as unknown as FakeRouter;

    expect(routerConstructorArgs).toEqual([[["nanoclaw"]]]);
    expect(router.registered.map((transport) => transport.name)).toEqual([
      "tmux",
      "scout",
      "zenoh-scout",
      "http",
      "nanoclaw",
    ]);
    expect(transportInstances.find((transport) => transport.name === "scout")?.options).toEqual({
      node: "m5",
      oracle: "mawjs-oracle",
      port: 4567,
      oracles: ["mawjs-oracle", "pulse-oracle"],
      autoPair: true,
    });
    await waitForAsyncTransportWork();
    expect(zenohScoutFactoryCalls).toEqual([configValue]);
    expect(transportInstances.find((transport) => transport.name === "zenoh-scout")?.options).toEqual({
      locator: "tcp/127.0.0.1:7447",
      fromPluginConfig: true,
    });
    expect(transportInstances.find((transport) => transport.name === "http")?.options).toEqual({
      peers: [{ name: "white", url: "http://white.local:3456" }],
      selfHost: "m5",
    });
    expect(transportInstances.filter((transport) => ["tmux", "scout", "zenoh-scout"].includes(transport.name)).map((transport) => transport.connect.mock.calls.length)).toEqual([1, 1, 1]);
  });

  test("discovery transport respects disabled zenoh-scout fallback branches", () => {
    expect(discoveryTransport({
      ...defaultConfig,
      discovery: { transport: "zenoh" },
      disabledPlugins: ["zenoh-scout"],
    } as any)).toBe("off");
    expect(discoveryTransport({
      ...defaultConfig,
      discovery: { transport: "both" },
      disabledPlugins: ["zenoh-scout"],
    } as any)).toBe("scout");
    expect(discoveryTransport({
      ...defaultConfig,
      discovery: { transport: "off" },
      disabledPlugins: ["zenoh-scout"],
    } as any)).toBe("off");
    expect(discoveryTransport({
      ...defaultConfig,
      discovery: {},
      disabledPlugins: ["zenoh-scout"],
    } as any)).toBe("scout");
    expect(discoveryTransport({ ...defaultConfig, scout: false, discovery: { transport: "scout" } } as any)).toBe("off");
    expect(discoveryTransport({ ...defaultConfig, scout: false, discovery: { transport: "both" } } as any)).toBe("zenoh");
  });

  test("dynamically loads and registers zenoh transport when locator is configured", async () => {
    configValue = {
      ...defaultConfig,
      zenoh: { locator: "tcp/127.0.0.1:7447" },
    };

    const router = createTransportRouter() as unknown as FakeRouter;
    await waitForAsyncTransportWork();

    const zenoh = transportInstances.find((transport) => transport.name === "zenoh");
    expect(zenoh?.options).toEqual({
      locator: "tcp/127.0.0.1:7447",
      node: "test-node",
    });
    expect(zenoh?.connect).toHaveBeenCalledTimes(1);
    expect(router.registered.map((transport) => transport.name)).toContain("zenoh");
  });

  test("warns when dynamically loaded zenoh transport fails to connect", async () => {
    const originalWarn = console.warn;
    const warn = mock(() => undefined);
    console.warn = warn;
    zenohConnectReject = new Error("bridge unavailable");
    configValue = {
      ...defaultConfig,
      zenoh: { locator: "tcp/127.0.0.1:7447" },
    };

    try {
      createTransportRouter();
      await waitForAsyncTransportWork();

      expect(warn).toHaveBeenCalledWith("[zenoh] connect failed: Error: bridge unavailable");
      expect(transportInstances.find((transport) => transport.name === "zenoh")?.connect).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("best-effort connect and reset catch handlers swallow transport failures", async () => {
    connectRejectByName = new Map<string, unknown>([
      ["tmux", new Error("tmux offline")],
      ["scout", new Error("scout offline")],
      ["zenoh-scout", new Error("zenoh scout offline")],
    ]);
    configValue = {
      ...defaultConfig,
      discovery: { transport: "both" },
      zenoh: { scout: { enabled: true } },
    };

    const router = createTransportRouter() as unknown as FakeRouter;
    await waitForAsyncTransportWork();

    expect(router.registered.map((transport) => transport.name)).toEqual([
      "tmux",
      "scout",
      "zenoh-scout",
      "nanoclaw",
    ]);
    expect(transportInstances.find((transport) => transport.name === "tmux")?.connect).toHaveBeenCalledTimes(1);
    expect(transportInstances.find((transport) => transport.name === "scout")?.connect).toHaveBeenCalledTimes(1);
    expect(transportInstances.find((transport) => transport.name === "zenoh-scout")?.connect).toHaveBeenCalledTimes(1);

    disconnectAllReject = new Error("disconnect failed");
    expect(() => resetTransportRouter()).not.toThrow();
    await waitForAsyncTransportWork();
    expect(router.disconnectAll).toHaveBeenCalledTimes(1);
  });

  test("reset disconnects the singleton router and get creates a fresh one afterward", () => {
    const first = getTransportRouter() as unknown as FakeRouter;

    resetTransportRouter();

    expect(first.disconnectAll).toHaveBeenCalledTimes(1);
    expect(first.registered.map((transport) => transport.disconnect.mock.calls.length)).toEqual([1, 1]);

    const second = getTransportRouter() as unknown as FakeRouter;
    expect(second).not.toBe(first);
    expect(routerInstances).toHaveLength(2);
  });
});
