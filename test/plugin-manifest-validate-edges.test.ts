import { describe, expect, test } from "bun:test";

const validators = await import("../src/plugin/manifest-validate");

function expectError(fn: () => unknown, message: string) {
  expect(fn).toThrow(message);
}

describe("manifest optional-field validator edge coverage", () => {
  test("parseCli rejects malformed cli shapes and preserves optional fields", () => {
    expect(validators.parseCli({})).toBeUndefined();
    expect(validators.parseCli({ cli: { command: "demo", aliases: ["d"], help: "hi", flags: { verbose: "boolean" } } })).toEqual({
      command: "demo",
      aliases: ["d"],
      help: "hi",
      flags: { verbose: "boolean" },
    });
    expectError(() => validators.parseCli({ cli: [] }), "plugin.json: cli must be an object");
    expectError(() => validators.parseCli({ cli: { command: "" } }), "plugin.json: cli.command must be a non-empty string");
    expectError(() => validators.parseCli({ cli: { command: "x", aliases: [1] } }), "plugin.json: cli.aliases must be an array of strings");
    expectError(() => validators.parseCli({ cli: { command: "x", flags: [] } }), "plugin.json: cli.flags must be an object");
    expectError(() => validators.parseCli({ cli: { command: "x", flags: { bad: "object" } } }), "plugin.json: cli.flags[\"bad\"] must be \"boolean\", \"string\", or \"number\"");
  });

  test("parseApi rejects malformed api objects", () => {
    expect(validators.parseApi({})).toBeUndefined();
    expect(validators.parseApi({ api: { path: "/api/demo", methods: ["GET", "POST"] } })).toEqual({ path: "/api/demo", methods: ["GET", "POST"] });
    expectError(() => validators.parseApi({ api: [] }), "plugin.json: api must be an object");
    expectError(() => validators.parseApi({ api: { path: "", methods: ["GET"] } }), "plugin.json: api.path must be a non-empty string");
    expectError(() => validators.parseApi({ api: { path: "/api/demo", methods: ["PUT"] } }), "plugin.json: api.methods must be an array");
  });

  test("parseHooks validates lifecycle hook branches", () => {
    expect(validators.parseHooks({})).toBeUndefined();
    expect(validators.parseHooks({ hooks: { wake: { script: "wake.ts", handler: "onWake", ensures: ["db"], policy: "best-effort" }, sleep: {}, serve: {} } })).toEqual({
      wake: { script: "wake.ts", handler: "onWake", ensures: ["db"], policy: "best-effort" },
      sleep: {},
      serve: {},
    });
    expectError(() => validators.parseHooks({ hooks: { wake: [] } }), "plugin.json: hooks.wake must be an object");
    expectError(() => validators.parseHooks({ hooks: { wake: { script: "" } } }), "plugin.json: hooks.wake.script must be a non-empty string");
    expectError(() => validators.parseHooks({ hooks: { sleep: { handler: "" } } }), "plugin.json: hooks.sleep.handler must be a non-empty string");
    expectError(() => validators.parseHooks({ hooks: { serve: { ensures: [""] } } }), "plugin.json: hooks.serve.ensures must be an array of non-empty strings");
    expectError(() => validators.parseHooks({ hooks: { wake: { policy: "hard" } } }), "plugin.json: hooks.wake.policy must be");
    expectError(() => validators.parseHooks({ hooks: [] }), "plugin.json: hooks must be an object");
    expectError(() => validators.parseHooks({ hooks: { on: [1] } }), "plugin.json: hooks.on must be an array of strings");
    expectError(() => validators.parseHooks({ hooks: { gate: [1] } }), "plugin.json: hooks.gate must be an array of strings");
    expectError(() => validators.parseHooks({ hooks: { filter: "not-array" } }), "plugin.json: hooks.filter must be an array of strings");
  });

  test("parseCron, parseModule, and parseTransport reject malformed sections", () => {
    expect(validators.parseCron({})).toBeUndefined();
    expect(validators.parseCron({ cron: { schedule: "* * * * *", handler: "tick" } })).toEqual({ schedule: "* * * * *", handler: "tick" });
    expectError(() => validators.parseCron({ cron: [] }), "plugin.json: cron must be an object");
    expectError(() => validators.parseCron({ cron: { schedule: "" } }), "plugin.json: cron.schedule must be a non-empty string");
    expectError(() => validators.parseCron({ cron: { schedule: "* * * * *", handler: 1 } }), "plugin.json: cron.handler must be a string");

    expect(validators.parseModule({})).toBeUndefined();
    expect(validators.parseModule({ module: { exports: ["thing"], path: "./mod.ts" } })).toEqual({ exports: ["thing"], path: "./mod.ts" });
    expectError(() => validators.parseModule({ module: [] }), "plugin.json: module must be an object");
    expectError(() => validators.parseModule({ module: { exports: [], path: "./mod.ts" } }), "plugin.json: module.exports must be a non-empty array of strings");
    expectError(() => validators.parseModule({ module: { exports: ["thing"], path: "" } }), "plugin.json: module.path must be a non-empty string");

    expect(validators.parseTransport({})).toBeUndefined();
    expect(validators.parseTransport({ transport: { peer: false } })).toEqual({ peer: false });
    expectError(() => validators.parseTransport({ transport: [] }), "plugin.json: transport must be an object");
    expectError(() => validators.parseTransport({ transport: { peer: "yes" } }), "plugin.json: transport.peer must be a boolean");
  });

  test("parseEngine rejects malformed serve process metadata", () => {
    expect(validators.parseEngine({})).toBeUndefined();
    expect(validators.parseEngine({ engine: {} })).toEqual({});
    expect(validators.parseEngine({ engine: { serve: { command: "bun run serve", prefix: "/api/demo", health: "/health", events: ["MessageSend"], eventPath: "/events" } } })).toEqual({
      serve: { command: "bun run serve", prefix: "/api/demo", health: "/health", events: ["MessageSend"], eventPath: "/events" },
    });
    expectError(() => validators.parseEngine({ engine: [] }), "plugin.json: engine must be an object");
    expectError(() => validators.parseEngine({ engine: { serve: [] } }), "plugin.json: engine.serve must be an object");
    expectError(() => validators.parseEngine({ engine: { serve: { command: "" } } }), "plugin.json: engine.serve.command must be a non-empty string");
    expectError(() => validators.parseEngine({ engine: { serve: { prefix: "/demo" } } }), "plugin.json: engine.serve.prefix must start with /api/");
    expectError(() => validators.parseEngine({ engine: { serve: { health: "health" } } }), "plugin.json: engine.serve.health must be an absolute path");
    expectError(() => validators.parseEngine({ engine: { serve: { eventPath: "events" } } }), "plugin.json: engine.serve.eventPath must be an absolute path");
    expectError(() => validators.parseEngine({ engine: { serve: { events: [""] } } }), "plugin.json: engine.serve.events must be an array of non-empty strings");
  });

  test("parseDependencies, parseArtifact, and parseTier cover compact and invalid shapes", () => {
    expect(validators.parseDependencies({})).toBeUndefined();
    expect(validators.parseDependencies({ dependencies: ["trace", "dig"] })).toEqual({ plugins: ["trace", "dig"] });
    expect(validators.parseDependencies({ dependencies: {} })).toEqual({});
    expectError(() => validators.parseDependencies({ dependencies: "trace" }), "plugin.json: dependencies must be an object or array of plugin names");
    expectError(() => validators.parseDependencies({ dependencies: { plugins: ["Bad Name"] } }), "plugin.json: dependencies.plugins must be an array of plugin names");

    expect(validators.parseArtifact({})).toBeUndefined();
    expect(validators.parseArtifact({ artifact: { path: "dist/index.js", sha256: null } })).toEqual({ path: "dist/index.js", sha256: null });
    expect(validators.parseArtifact({ artifact: { path: "dist/index.js", sha256: "abc" } })).toEqual({ path: "dist/index.js", sha256: "abc" });
    expectError(() => validators.parseArtifact({ artifact: [] }), "plugin.json: artifact must be an object");
    expectError(() => validators.parseArtifact({ artifact: { path: "" } }), "plugin.json: artifact.path must be a non-empty string");
    expectError(() => validators.parseArtifact({ artifact: { path: "dist/index.js", sha256: 1 } }), "plugin.json: artifact.sha256 must be a string or null");

    expect(validators.parseTier({})).toBeUndefined();
    expect(validators.parseTier({ tier: "core" })).toBe("core");
    expectError(() => validators.parseTier({ tier: "primary" }), "plugin.json: tier must be");
  });

  test("target and capability validators cover valid, invalid, and warning branches", () => {
    expect(validators.parseTarget({})).toBeUndefined();
    expect(validators.parseTarget({ target: "js" })).toBe("js");
    expectError(() => validators.parseTarget({ target: 1 }), "plugin.json: target must be a string");
    expectError(() => validators.parseTarget({ target: "wasm" }), "plugin.json: target \"wasm\" not yet supported");
    expectError(() => validators.parseTarget({ target: "python" }), "plugin.json: unknown target");

    expect(validators.parseCapabilityNamespaces({})).toBeUndefined();
    expect(validators.parseCapabilityNamespaces({ capabilityNamespaces: ["messages", "messages", "storage"] })).toEqual(["messages", "storage"]);
    expectError(() => validators.parseCapabilityNamespaces({ capabilityNamespaces: ["Bad Name"] }), "plugin.json: capabilityNamespaces must be an array of slug strings");

    expect(validators.parseCapabilities({}, [])).toBeUndefined();
    expect(validators.parseCapabilities({ capabilities: ["sdk:identity", "messages:ledger"] }, ["messages"])).toEqual(["sdk:identity", "messages:ledger"]);
    expectError(() => validators.parseCapabilities({ capabilities: [1] }, []), "plugin.json: capabilities must be an array of strings");

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      expect(validators.parseCapabilities({ capabilities: ["unknown:thing"] }, [])).toEqual(["unknown:thing"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("unknown capability namespace");
  });
});
