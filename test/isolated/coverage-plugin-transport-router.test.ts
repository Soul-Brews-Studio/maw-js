import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const calls: string[] = [];
let config: any = {};

class FakeRouter {
  registered: Array<{ name: string }> = [];
  register(transport: { name: string }) {
    calls.push(`register:${transport.name}`);
    this.registered.push(transport);
  }
  async disconnectAll() {
    calls.push("disconnectAll");
  }
}

function fakeTransport(name: string) {
  return class {
    name = name;
    constructor(...args: unknown[]) {
      calls.push(`construct:${name}:${args.length}`);
    }
    async connect() {
      calls.push(`connect:${name}`);
    }
    async disconnect() {}
    async send() { return true; }
    async publishPresence() {}
    async publishFeed() {}
    onMessage() {}
    onPresence() {}
    onFeed() {}
    canReach() { return false; }
  };
}

mock.module(join(srcRoot, "src/config"), () => ({ loadConfig: () => config }));
mock.module(join(srcRoot, "src/core/transport/transport"), () => ({ TransportRouter: FakeRouter }));
mock.module(join(srcRoot, "src/transports/tmux"), () => ({ TmuxTransport: fakeTransport("tmux") }));
mock.module(join(srcRoot, "src/transports/http"), () => ({ HttpTransport: fakeTransport("http") }));
mock.module(join(srcRoot, "src/transports/nanoclaw"), () => ({ NanoclawTransport: fakeTransport("nanoclaw") }));
mock.module(join(srcRoot, "src/transports/scout"), () => ({ ScoutTransport: fakeTransport("scout") }));
mock.module(join(srcRoot, "src/plugin/registry"), () => ({
  importPluginSymbol: async () => (cfg: any) => new (fakeTransport("zenoh-scout"))({ locator: cfg.zenoh?.scout?.locator ?? "memory" }),
}));
mock.module(join(srcRoot, "src/transports/zenoh"), () => ({ ZenohTransport: fakeTransport("zenoh") }));
mock.module(join(srcRoot, "src/transports/zenoh.ts"), () => ({ ZenohTransport: fakeTransport("zenoh") }));

const transports = await import("../../src/transports/index");

afterEach(() => {
  transports.resetTransportRouter();
  calls.length = 0;
  config = {};
});

describe("transport router coverage", () => {
  test("discoveryTransport handles invalid config and disabled plugin fallbacks", () => {
    expect(transports.discoveryTransport({ discovery: { transport: "invalid" } } as any)).toBe("scout");
    expect(transports.discoveryTransport({ discovery: { transport: "invalid" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("scout");
    expect(transports.discoveryTransport({ discovery: { transport: "zenoh" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("off");
    expect(transports.discoveryTransport({ discovery: { transport: "both" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("scout");
    expect(transports.discoveryTransport({ discovery: { transport: "off" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("off");
    expect(transports.discoveryTransport({ zenoh: { scout: { enabled: true } } } as any)).toBe("both");
  });

  test("create/get/reset router covers minimal and optional registration paths", async () => {
    config = { node: "node-a", discovery: { transport: "off" }, agents: {}, peers: [] };

    const minimal = transports.createTransportRouter() as unknown as FakeRouter;
    expect(transports.getTransportRouter()).toBe(minimal);
    expect(minimal.registered.map((t) => t.name)).toEqual(["tmux", "nanoclaw"]);
    expect(calls).toContain("connect:tmux");

    transports.resetTransportRouter();
    expect(calls).toContain("disconnectAll");
    calls.length = 0;

    config = {
      node: "node-a",
      oracle: "oracle-a",
      port: 3456,
      agents: { "alpha-oracle": "local", plain: "remote" },
      peers: [{ name: "peer", url: "http://peer.example.test" }],
      discovery: { transport: "both" },
      zenoh: { locator: "ws/127.0.0.1:7447", scout: { locator: "memory" } },
    };
    const optional = transports.createTransportRouter() as unknown as FakeRouter;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(optional.registered.map((t) => t.name)).toEqual([
      "tmux",
      "scout",
      "zenoh-scout",
      "http",
      "nanoclaw",
      "zenoh",
    ]);
    expect(calls).toContain("construct:http:1");
  });
});
