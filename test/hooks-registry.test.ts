/**
 * Tests for src/plugins/30_hooks-registry.ts — registerManifestHooks.
 *
 * discoverPackages is mocked to return controlled fixtures.
 * Plugin entryPaths are mocked module specifiers — no real files needed.
 */

import { describe, test, expect, beforeAll, mock } from "bun:test";

// --- Mutable fixture list — set per test before calling registerManifestHooks ---
let pluginFixtures: any[] = [];

// Stub the plugin registry. Bun hoists mock.module calls, so this is active
// before registerManifestHooks (which dynamic-imports the registry) is called.
mock.module("../src/plugin/registry", () => ({
  discoverPackages: () => pluginFixtures,
}));

// --- Mock entry modules (absolute paths so they never hit the filesystem) ---

const GATE_ENTRY = "/tmp/maw-test-hooks-gate";
const ON_ENTRY = "/tmp/maw-test-hooks-on";
const BOTH_ENTRY = "/tmp/maw-test-hooks-both";

const gateFn = mock(() => true);
const onFn = mock(async () => {});

mock.module(GATE_ENTRY, () => ({ onGate: gateFn }));
mock.module(ON_ENTRY, () => ({ onEvent: onFn }));
mock.module(BOTH_ENTRY, () => ({ onGate: gateFn, onEvent: onFn }));

// --- Minimal PluginSystem stand-in (avoids pulling in full dependency chain) ---

function makeSystem() {
  const hookCalls: Record<string, Array<[string, Function]>> = {
    gate: [],
    filter: [],
    on: [],
    late: [],
  };
  const registered: Array<{ name: string; type: string }> = [];
  return {
    hooks: {
      gate: (ev: string, fn: Function) => hookCalls.gate.push([ev, fn]),
      filter: (ev: string, fn: Function) => hookCalls.filter.push([ev, fn]),
      on: (ev: string, fn: Function) => hookCalls.on.push([ev, fn]),
      late: (ev: string, fn: Function) => hookCalls.late.push([ev, fn]),
    },
    register: (name: string, type: string) => registered.push({ name, type }),
    _hookCalls: hookCalls,
    _registered: registered,
  };
}

// --- Import SUT ---

let registerManifestHooks: (system: any) => Promise<number>;

beforeAll(async () => {
  ({ registerManifestHooks } = await import("../src/plugins/30_hooks-registry"));
});

// --- Tests ---

describe("registerManifestHooks", () => {
  test("plugin with hooks.gate → gate handler registered", async () => {
    pluginFixtures = [
      {
        manifest: {
          name: "gate-plugin",
          version: "1.0.0",
          sdk: "^1.0.0",
          hooks: { gate: ["msg:in"] },
        },
        dir: "/tmp/gate",
        wasmPath: "",
        entryPath: GATE_ENTRY,
        kind: "ts",
      },
    ];
    const system = makeSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(1);
    expect(system._hookCalls.gate).toHaveLength(1);
    expect(system._hookCalls.gate[0][0]).toBe("msg:in");
  });

  test("plugin with hooks.on → event handler registered", async () => {
    pluginFixtures = [
      {
        manifest: {
          name: "on-plugin",
          version: "1.0.0",
          sdk: "^1.0.0",
          hooks: { on: ["feed:update"] },
        },
        dir: "/tmp/on",
        wasmPath: "",
        entryPath: ON_ENTRY,
        kind: "ts",
      },
    ];
    const system = makeSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(1);
    expect(system._hookCalls.on).toHaveLength(1);
    expect(system._hookCalls.on[0][0]).toBe("feed:update");
  });

  test("WASM plugin is skipped (only TS supported)", async () => {
    pluginFixtures = [
      {
        manifest: {
          name: "wasm-plugin",
          version: "1.0.0",
          sdk: "^1.0.0",
          hooks: { on: ["msg:in"] },
        },
        dir: "/tmp/wasm",
        wasmPath: "/tmp/wasm/plugin.wasm",
        kind: "wasm", // no entryPath
      },
    ];
    const system = makeSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
    expect(system._hookCalls.on).toHaveLength(0);
  });

  test("returns count of registered hooks (gate + on events)", async () => {
    pluginFixtures = [
      {
        manifest: {
          name: "multi-plugin",
          version: "1.0.0",
          sdk: "^1.0.0",
          hooks: { gate: ["a", "b"], on: ["c"] },
        },
        dir: "/tmp/both",
        wasmPath: "",
        entryPath: BOTH_ENTRY,
        kind: "ts",
      },
    ];
    const system = makeSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(3); // 2 gate + 1 on
    expect(system._hookCalls.gate).toHaveLength(2);
    expect(system._hookCalls.on).toHaveLength(1);
  });

  test("plugin without hooks field → skipped, count=0", async () => {
    pluginFixtures = [
      {
        manifest: { name: "no-hooks", version: "1.0.0", sdk: "^1.0.0" },
        dir: "/tmp/no-hooks",
        wasmPath: "",
        entryPath: GATE_ENTRY,
        kind: "ts",
      },
    ];
    const system = makeSystem();
    const count = await registerManifestHooks(system);
    expect(count).toBe(0);
    expect(system._registered).toHaveLength(0);
  });
});
