import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const calls: string[] = [];
let connectRejectNames = new Set<string>();
let config: any = {};
let workspaces: any[] = [];

class FakeRouter {
  registered: Array<{ name: string }> = [];
  register(transport: { name: string }) {
    calls.push(`register:${transport.name}`);
    this.registered.push(transport);
  }
  async disconnectAll() { calls.push("disconnectAll"); }
}

function fakeTransport(name: string) {
  return class {
    name = name;
    constructor(...args: unknown[]) { calls.push(`construct:${name}:${args.length}`); }
    async connect() {
      calls.push(`connect:${name}`);
      if (connectRejectNames.has(name)) throw new Error(`${name} down`);
    }
    async disconnect() {}
    async send() { return true; }
    onMessage() {}
    onPresence() {}
    onFeed() {}
    canReach() { return false; }
  };
}

mock.module(join(srcRoot, "src/config"), () => ({ loadConfig: () => config }));
mock.module(join(srcRoot, "src/core/transport/transport"), () => ({ TransportRouter: FakeRouter }));
mock.module(join(srcRoot, "src/transports/tmux"), () => ({ TmuxTransport: fakeTransport("tmux") }));
mock.module(join(srcRoot, "src/transports/hub"), () => ({
  loadWorkspaceConfigs: () => workspaces,
  HubTransport: fakeTransport("hub"),
}));
mock.module(join(srcRoot, "src/transports/http"), () => ({ HttpTransport: fakeTransport("http") }));
mock.module(join(srcRoot, "src/transports/lora"), () => ({ LoRaTransport: fakeTransport("lora") }));
mock.module(join(srcRoot, "src/transports/nanoclaw"), () => ({ NanoclawTransport: fakeTransport("nanoclaw") }));
mock.module(join(srcRoot, "src/transports/mdns"), () => ({ MdnsTransport: fakeTransport("mdns") }));
mock.module(join(srcRoot, "src/transports/scout"), () => ({ ScoutTransport: fakeTransport("scout") }));
mock.module(join(srcRoot, "src/transports/zenoh-scout"), () => ({ ZenohScoutTransport: fakeTransport("zenoh-scout") }));
mock.module(join(srcRoot, "src/vendor/mpr-plugins/zenoh-scout/impl"), () => ({
  readZenohScoutConfig: (cfg: any) => ({ locator: cfg.zenoh?.scout?.locator ?? "memory" }),
}));
mock.module(join(srcRoot, "src/transports/zenoh"), () => ({ ZenohTransport: fakeTransport("zenoh") }));
mock.module(join(srcRoot, "src/transports/zenoh.ts"), () => ({ ZenohTransport: fakeTransport("zenoh") }));

const transports = await import("../../src/transports/index.ts?function-coverage");
const originalWarn = console.warn;

afterEach(() => {
  console.warn = originalWarn;
  transports.resetTransportRouter();
});

describe("transport index function coverage", () => {
  test("discoveryTransport covers configured and fallback branches", () => {
    expect(transports.discoveryTransport({ discovery: { transport: "off" } } as any)).toBe("off");
    expect(transports.discoveryTransport({ discovery: { transport: "zenoh" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("off");
    expect(transports.discoveryTransport({ discovery: { transport: "both" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("scout");
    expect(transports.discoveryTransport({ discovery: { transport: "scout" }, disabledPlugins: ["zenoh-scout"] } as any)).toBe("scout");
    expect(transports.discoveryTransport({ zenoh: { scout: { enabled: true } } } as any)).toBe("both");
    expect(transports.discoveryTransport({ disabledPlugins: ["zenoh-scout"] } as any)).toBe("scout");
  });

  test("create/get/reset router registers every optional transport and handles async catches", async () => {
    calls.length = 0;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    connectRejectNames = new Set(["tmux", "scout", "zenoh-scout", "zenoh"]);
    config = {
      node: "m5",
      oracle: "mawjs",
      port: 3456,
      agents: { "neo-oracle": "local", plain: "remote" },
      peers: [{ name: "white", url: "http://white:3456" }],
      discovery: { transport: "both" },
      disabledPlugins: [],
      zenoh: { locator: "tcp/127.0.0.1:7447", scout: { locator: "memory" } },
    };
    workspaces = [{ node: "workspace" }];

    const router = transports.createTransportRouter() as unknown as FakeRouter;
    expect(transports.getTransportRouter()).toBe(router);
    expect(transports.createTransportRouter()).toBe(router);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(router.registered.map((t) => t.name)).toEqual([
      "tmux",
      "hub",
      "scout",
      "zenoh-scout",
      "http",
      "nanoclaw",
      "lora",
      "zenoh",
    ]);
    expect(warnings.join("\n")).toContain("[zenoh] connect failed: Error: zenoh down");

    transports.resetTransportRouter();
    expect(calls).toContain("disconnectAll");
    transports.resetTransportRouter();
  });
});
