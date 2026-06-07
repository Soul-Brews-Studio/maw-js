import { describe, expect, spyOn, test } from "bun:test";
import {
  parseArtifact,
  parseCapabilities,
  parseCapabilityNamespaces,
  parseDependencies,
  parseEngine,
  parseHooks,
  parseTarget,
  parseTier,
  parseTransport,
} from "../src/plugin/manifest-validate";

function expectError(fn: () => unknown, message: string) {
  expect(fn).toThrow(message);
}

describe("manifest optional-field validators — default coverage", () => {
  test("parseTransport accepts missing and explicit peer defaults", () => {
    expect(parseTransport({})).toBeUndefined();
    expect(parseTransport({ transport: {} })).toEqual({});
    expect(parseTransport({ transport: { peer: true } })).toEqual({ peer: true });
    expect(parseTransport({ transport: { peer: false } })).toEqual({ peer: false });

    expectError(() => parseTransport({ transport: null }), "plugin.json: transport must be an object");
    expectError(() => parseTransport({ transport: { peer: 1 } }), "plugin.json: transport.peer must be a boolean");
  });

  test("parseEngine accepts partial serve metadata and rejects non-string path fields", () => {
    expect(parseEngine({})).toBeUndefined();
    expect(parseEngine({ engine: {} })).toEqual({});
    expect(parseEngine({ engine: { serve: {} } })).toEqual({ serve: {} });
    expect(parseEngine({ engine: { serve: { prefix: "/api/plugin", health: "/health" } } })).toEqual({
      serve: { prefix: "/api/plugin", health: "/health" },
    });
    expect(parseEngine({ engine: { serve: { events: [] } } })).toEqual({ serve: { events: [] } });

    expectError(() => parseEngine({ engine: null }), "plugin.json: engine must be an object");
    expectError(() => parseEngine({ engine: { serve: null } }), "plugin.json: engine.serve must be an object");
    expectError(() => parseEngine({ engine: { serve: { prefix: 1 } } }), "plugin.json: engine.serve.prefix must start with /api/");
    expectError(() => parseEngine({ engine: { serve: { health: 1 } } }), "plugin.json: engine.serve.health must be an absolute path");
    expectError(() => parseEngine({ engine: { serve: { eventPath: 1 } } }), "plugin.json: engine.serve.eventPath must be an absolute path");
    expectError(() => parseEngine({ engine: { serve: { events: "MessageSend" } } }), "plugin.json: engine.serve.events must be an array of non-empty strings");
  });

  test("parseTarget returns only supported js and includes exact unsupported target details", () => {
    expect(parseTarget({})).toBeUndefined();
    expect(parseTarget({ target: "js" })).toBe("js");

    expectError(() => parseTarget({ target: null }), "plugin.json: target must be a string");
    expectError(() => parseTarget({ target: "wasm" }), 'plugin.json: target "wasm" not yet supported (Phase C). Use target "js" for now.');
    expectError(() => parseTarget({ target: "python" }), 'plugin.json: unknown target "python" (expected "js")');
  });

  test("parseCapabilityNamespaces deduplicates slugs and rejects invalid namespace containers", () => {
    expect(parseCapabilityNamespaces({})).toBeUndefined();
    expect(parseCapabilityNamespaces({ capabilityNamespaces: [] })).toEqual([]);
    expect(parseCapabilityNamespaces({ capabilityNamespaces: ["custom", "custom", "x-1"] })).toEqual(["custom", "x-1"]);

    expectError(() => parseCapabilityNamespaces({ capabilityNamespaces: "custom" }), "plugin.json: capabilityNamespaces must be an array of slug strings");
    expectError(() => parseCapabilityNamespaces({ capabilityNamespaces: ["Custom"] }), "plugin.json: capabilityNamespaces must be an array of slug strings");
    expectError(() => parseCapabilityNamespaces({ capabilityNamespaces: [1] }), "plugin.json: capabilityNamespaces must be an array of slug strings");
  });

  test("parseCapabilities accepts known and declared namespaces without warnings", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseCapabilities({})).toBeUndefined();
      expect(parseCapabilities({ capabilities: [] })).toEqual([]);
      expect(parseCapabilities({ capabilities: ["sdk", "sdk:identity", "custom", "custom:thing"] }, ["custom"])).toEqual([
        "sdk",
        "sdk:identity",
        "custom",
        "custom:thing",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("parseCapabilities preserves unknown capabilities while warning with namespace details", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseCapabilities({ capabilities: ["mystery", "unknown:value"] }, ["custom"])).toEqual(["mystery", "unknown:value"]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain('unknown capability namespace "mystery" in "mystery"');
      expect(String(warn.mock.calls[1][0])).toContain('unknown capability namespace "unknown" in "unknown:value"');
      expect(String(warn.mock.calls[1][0])).toContain("custom");
    } finally {
      warn.mockRestore();
    }

    expectError(() => parseCapabilities({ capabilities: "sdk:identity" }), "plugin.json: capabilities must be an array of strings");
    expectError(() => parseCapabilities({ capabilities: [null] }), "plugin.json: capabilities must be an array of strings");
  });

  test("later helpers preserve defaults and reject edge invalid shapes", () => {
    expect(parseDependencies({})).toBeUndefined();
    expect(parseDependencies({ dependencies: [] })).toEqual({ plugins: [] });
    expect(parseDependencies({ dependencies: { plugins: ["trace", "x-1"] } })).toEqual({ plugins: ["trace", "x-1"] });
    expect(parseDependencies({ dependencies: { plugins: undefined } })).toEqual({});
    expectError(() => parseDependencies({ dependencies: { plugins: [1] } }), "plugin.json: dependencies.plugins must be an array of plugin names");

    expect(parseArtifact({})).toBeUndefined();
    expect(parseArtifact({ artifact: { path: "dist/plugin.js", sha256: "sha256:abc" } })).toEqual({ path: "dist/plugin.js", sha256: "sha256:abc" });
    expect(parseArtifact({ artifact: { path: "dist/plugin.js", sha256: null } })).toEqual({ path: "dist/plugin.js", sha256: null });
    expectError(() => parseArtifact({ artifact: { path: "dist/plugin.js" } }), "plugin.json: artifact.sha256 must be a string or null");
    expectError(() => parseArtifact({ artifact: { path: "dist/plugin.js", sha256: false } }), "plugin.json: artifact.sha256 must be a string or null");

    expect(parseTier({})).toBeUndefined();
    expect(parseTier({ tier: "core" })).toBe("core");
    expect(parseTier({ tier: "standard" })).toBe("standard");
    expect(parseTier({ tier: "extra" })).toBe("extra");
    expectError(() => parseTier({ tier: 1 }), 'plugin.json: tier must be "core", "standard", or "extra" (got 1)');
  });

  test("parseHooks preserves default array fields including late hooks", () => {
    expect(parseHooks({ hooks: { gate: [], filter: ["Clean"], on: ["MessageSend"], late: ["After"] } })).toEqual({
      gate: [],
      filter: ["Clean"],
      on: ["MessageSend"],
      late: ["After"],
    });
    expectError(() => parseHooks({ hooks: { late: [1] } }), "plugin.json: hooks.late must be an array of strings");
  });
});
