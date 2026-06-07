import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

class FakeRouter {
  registered: Array<{ name: string }> = [];
  register(transport: { name: string }) {
    this.registered.push(transport);
  }
  async disconnectAll() {}
}

function fakeTransport(name: string) {
  return class {
    name = name;
    async connect() {}
    async disconnect() {}
    async send() { return true; }
    onMessage() {}
    onPresence() {}
    onFeed() {}
    canReach() { return false; }
  };
}

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => ({
    node: "m5",
    oracle: "mawjs",
    port: 3456,
    agents: {},
    peers: [],
    discovery: { transport: "off" },
    disabledPlugins: [],
    zenoh: { locator: "tcp/127.0.0.1:7447" },
  }),
}));

mock.module(join(srcRoot, "src/core/transport/transport"), () => ({ TransportRouter: FakeRouter }));
mock.module(join(srcRoot, "src/transports/tmux"), () => ({ TmuxTransport: fakeTransport("tmux") }));
mock.module(join(srcRoot, "src/transports/hub"), () => ({
  loadWorkspaceConfigs: () => [],
  HubTransport: fakeTransport("hub"),
}));
mock.module(join(srcRoot, "src/transports/http"), () => ({ HttpTransport: fakeTransport("http") }));
mock.module(join(srcRoot, "src/transports/lora"), () => ({ LoRaTransport: fakeTransport("lora") }));
mock.module(join(srcRoot, "src/transports/nanoclaw"), () => ({ NanoclawTransport: fakeTransport("nanoclaw") }));
mock.module(join(srcRoot, "src/transports/mdns"), () => ({ MdnsTransport: fakeTransport("mdns") }));
mock.module(join(srcRoot, "src/transports/scout"), () => ({ ScoutTransport: fakeTransport("scout") }));
mock.module(join(srcRoot, "src/transports/zenoh-scout"), () => ({ ZenohScoutTransport: fakeTransport("zenoh-scout") }));
mock.module(join(srcRoot, "src/vendor/mpr-plugins/zenoh-scout/impl"), () => ({
  readZenohScoutConfig: () => ({}),
}));

mock.module(join(srcRoot, "src/transports/zenoh"), () => {
  throw new Error("wasm unavailable");
});
mock.module(join(srcRoot, "src/transports/zenoh.ts"), () => {
  throw new Error("wasm unavailable");
});

const { createTransportRouter, resetTransportRouter } = await import("../../src/transports/index.ts?zenoh-load-failure");

const originalWarn = console.warn;

afterEach(() => {
  console.warn = originalWarn;
  resetTransportRouter();
});

describe("transport registry zenoh load failure coverage", () => {
  test("dynamic zenoh import failures warn and leave the base router usable", async () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    const router = createTransportRouter() as unknown as FakeRouter;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(router.registered.map((transport) => transport.name)).toEqual(["tmux", "nanoclaw", "lora"]);
    expect(warnings).toContain("[zenoh] load failed: Error: wasm unavailable");
  });
});
