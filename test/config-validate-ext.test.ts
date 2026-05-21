import { describe, expect, test } from "bun:test";

const { validateConfig } = await import(`${process.cwd()}/src/config/validate-ext.ts?config-validate-ext-${Date.now()}`);

function validateWithWarnings(raw: Record<string, unknown>) {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    return { result: validateConfig(raw), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

describe("validateConfig extended fields", () => {
  test("accepts and trims every supported extended config field", () => {
    const nanoclaw = { endpoint: "http://127.0.0.1:9999" };
    const { result, warnings } = validateWithWarnings({
      host: "  m5  ",
      triggers: [{ on: "ready", action: "maw hey oracle hi" }],
      federationToken: "0123456789abcdef",
      allowPeersWithoutToken: true,
      trustLoopback: false,
      pin: "1234",
      zenoh: {
        locator: "ws/127.0.0.1:7447",
        scout: {
          enabled: true,
          locator: "ws/127.0.0.1:7448",
          timeoutMs: 2500,
          keyPrefix: "maw/dev",
        },
      },
      discovery: { transport: "both" },
      pluginSources: ["https://plugins.example/registry.json"],
      disabledPlugins: ["debug-only"],
      migrations: { healedDefaults: true, keptManual: false, ignored: "nope" },
      node: "  m5  ",
      nodeUser: "  alpha  ",
      serviceUser: "  beta  ",
      oracle: "  mawjs-codex  ",
      namedPeers: [{ name: "m6", url: "http://m6.local:3456" }],
      agents: { mawjs: "m5" },
      peers: ["http://m6.local:3456"],
      githubOrg: "Soul-Brews-Studio",
      nanoclaw,
    });

    expect(warnings).toEqual([]);
    expect(result).toEqual({
      host: "m5",
      triggers: [{ on: "ready", action: "maw hey oracle hi" }],
      federationToken: "0123456789abcdef",
      allowPeersWithoutToken: true,
      trustLoopback: false,
      pin: "1234",
      zenoh: {
        locator: "ws/127.0.0.1:7447",
        scout: {
          enabled: true,
          locator: "ws/127.0.0.1:7448",
          timeoutMs: 2500,
          keyPrefix: "maw/dev",
        },
      },
      discovery: { transport: "both" },
      pluginSources: ["https://plugins.example/registry.json"],
      disabledPlugins: ["debug-only"],
      migrations: { healedDefaults: true, keptManual: false },
      node: "m5",
      nodeUser: "alpha",
      serviceUser: "beta",
      oracle: "mawjs-codex",
      namedPeers: [{ name: "m6", url: "http://m6.local:3456" }],
      agents: { mawjs: "m5" },
      peers: ["http://m6.local:3456"],
      githubOrg: "Soul-Brews-Studio",
      nanoclaw,
    });
  });

  test("filters invalid array entries while warning for lossy containers", () => {
    const validTrigger = { on: "message", action: "maw hey m5:mawjs ok" };
    const { result, warnings } = validateWithWarnings({
      triggers: [validTrigger, null, { on: 123, action: "bad" }, { on: "missing-action" }],
      federationToken: "too-short",
      allowPeersWithoutToken: "true",
      trustLoopback: "false",
      pin: 123,
      zenoh: {
        locator: 123,
        scout: { enabled: "yes", locator: 456, timeoutMs: -1, keyPrefix: "" },
      },
      discovery: { transport: "carrier-pigeon" },
      pluginSources: ["file:///plugins.json", 7, "https://plugins.example/index.json"],
      disabledPlugins: ["dev-only", false, "experimental"],
      migrations: { done: true, pending: false, ignored: "no" },
      node: "   ",
      nodeUser: "   ",
      serviceUser: 42,
      oracle: 42,
      namedPeers: [
        { name: "m6", url: "http://m6.local:3456" },
        { name: 1, url: "http://bad.local:3456" },
        { name: "bad-url", url: "not a url" },
        null,
      ],
      agents: [],
      peers: ["http://m6.local:3456", 8, "not a url"],
      githubOrg: 99,
      nanoclaw: "disabled",
    });

    expect(result).toEqual({
      triggers: [validTrigger],
      pluginSources: ["file:///plugins.json", "https://plugins.example/index.json"],
      disabledPlugins: ["dev-only", "experimental"],
      migrations: { done: true, pending: false },
      namedPeers: [{ name: "m6", url: "http://m6.local:3456" }],
      peers: ["http://m6.local:3456"],
    });
    expect(warnings).toEqual([
      "[maw] config warning: triggers has 3 invalid entries, keeping valid ones, using default",
      "[maw] config warning: federationToken must be at least 16 characters, using default",
      "[maw] config warning: allowPeersWithoutToken must be a boolean, using default",
      "[maw] config warning: trustLoopback must be a boolean, using default",
      "[maw] config warning: pin must be a string, using default",
      "[maw] config warning: discovery.transport must be one of: scout, zenoh, both, off, using default",
      "[maw] config warning: node must be a non-empty string, using default",
      "[maw] config warning: nodeUser must be a non-empty string, using default",
      "[maw] config warning: serviceUser must be a non-empty string, using default",
      "[maw] config warning: oracle must be a non-empty string, using default",
      "[maw] config warning: namedPeers has 3 invalid entries, using default",
      "[maw] config warning: agents must be an object mapping agent names to node names, using default",
      "[maw] config warning: peers has 2 invalid URL(s), keeping valid ones, using default",
    ]);
  });

  test("warns for invalid extended-field container types", () => {
    const { result, warnings } = validateWithWarnings({
      triggers: "always",
      federationToken: 123,
      pluginSources: { url: "https://plugins.example" },
      disabledPlugins: { name: "debug-only" },
      migrations: [],
      namedPeers: { m6: "http://m6.local:3456" },
      agents: null,
      peers: { m6: "http://m6.local:3456" },
      discovery: [],
      zenoh: null,
      nanoclaw: null,
    });

    expect(result).toEqual({});
    expect(warnings).toEqual([
      "[maw] config warning: triggers must be an array, using default",
      "[maw] config warning: federationToken must be a string, using default",
      "[maw] config warning: pluginSources must be an array of URL strings, using default",
      "[maw] config warning: disabledPlugins must be an array of plugin names, using default",
      "[maw] config warning: migrations must be an object of boolean markers, using default",
      "[maw] config warning: namedPeers must be an array of {name, url}, using default",
      "[maw] config warning: agents must be an object mapping agent names to node names, using default",
      "[maw] config warning: peers must be an array of URLs, using default",
    ]);
  });

  test("keeps empty valid containers explicit and recognizes each discovery transport", () => {
    for (const transport of ["scout", "zenoh", "both", "off"] as const) {
      const { result, warnings } = validateWithWarnings({
        triggers: [],
        namedPeers: [],
        peers: [],
        pluginSources: [],
        disabledPlugins: [],
        migrations: {},
        agents: {},
        discovery: { transport },
      });

      expect(warnings).toEqual([]);
      expect(result).toEqual({
        triggers: [],
        namedPeers: [],
        peers: [],
        pluginSources: [],
        disabledPlugins: [],
        migrations: {},
        agents: {},
        discovery: { transport },
      });
    }
  });
});
