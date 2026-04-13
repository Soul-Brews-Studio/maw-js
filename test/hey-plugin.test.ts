/**
 * Tests for maw hey plugin:<name> routing in cmdSend.
 *
 * Stubs plugin/registry and config to avoid filesystem + tmux dependencies.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// --- Stub types (mirrors src/plugin/types.ts) ---
interface LoadedPlugin {
  manifest: { name: string; version: string; wasm: string; sdk: string };
  dir: string;
  wasmPath: string;
}

// --- Mutable stubs ---
let fakePlugins: LoadedPlugin[] = [
  {
    manifest: { name: "hello-package", version: "1.0.0", wasm: "hello.wasm", sdk: "^1.0.0" },
    dir: "/tmp/hello-package",
    wasmPath: "/tmp/hello-package/hello.wasm",
  },
];
let fakeInvokeResult: { ok: boolean; output?: string; error?: string } = {
  ok: true,
  output: "federation context: source=peer from=local-node",
};

mock.module("../src/plugin/registry", () => ({
  discoverPackages: () => fakePlugins,
  invokePlugin: async (_plugin: LoadedPlugin, _ctx: unknown) => fakeInvokeResult,
}));

mock.module("../src/config", () => ({ getEnvVars: () => ({}), buildCommand: () => "echo test", saveConfig: () => {}, validateConfig: (c: any) => c,
  loadConfig: () => ({ node: "local-node", port: 3456 }),
  cfgLimit: (_key: string) => 200,
}));

mock.module("../src/core/transport/ssh", () => ({
  listSessions: async () => [],
  capture: async () => "",
  sendKeys: async () => {},
  getPaneCommand: async () => "",
  getPaneCommands: async () => [],
  getPaneInfos: async () => ({}),
}));

mock.module("../src/core/routing", () => ({
  resolveTarget: () => ({ type: "error", detail: "not found", hint: "" }),
}));

mock.module("../src/core/runtime/hooks", () => ({ runHook: async () => {} }));
mock.module("../src/core/transport/peers", () => ({ findPeerForTarget: async () => undefined }));
mock.module("../src/core/fleet/worktrees", () => ({ scanWorktrees: async () => [] }));
mock.module("../src/core/runtime/find-window", () => ({ findWindow: () => undefined }));
mock.module("../src/core/transport/curl-fetch", () => ({ curlFetch: async () => ({ ok: false, data: {} }) }));
mock.module("../src/commands/shared/wake", () => ({ resolveFleetSession: () => undefined }));

import { cmdSend } from "../src/commands/shared/comm";

describe("maw hey plugin:<name> routing", () => {
  let exitCode: number | undefined;
  let consoleOut: string[] = [];
  let consoleErr: string[] = [];
  let originalExit: typeof process.exit;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    exitCode = undefined;
    consoleOut = [];
    consoleErr = [];

    originalExit = process.exit;
    originalLog = console.log;
    originalError = console.error;

    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    console.log = (...args: unknown[]) => { consoleOut.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { consoleErr.push(args.join(" ")); };

    // Reset stubs to defaults
    fakePlugins = [
      {
        manifest: { name: "hello-package", version: "1.0.0", wasm: "hello.wasm", sdk: "^1.0.0" },
        dir: "/tmp/hello-package",
        wasmPath: "/tmp/hello-package/hello.wasm",
      },
    ];
    fakeInvokeResult = { ok: true, output: "federation context: source=peer from=local-node" };
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  test("plugin:<name> invokes registry and prints output", async () => {
    await cmdSend("plugin:hello-package", "test from peer");

    expect(exitCode).toBeUndefined();
    expect(consoleOut.some(l => l.includes("federation context"))).toBe(true);
  });

  test("plugin:<name> with no output prints (no output)", async () => {
    fakeInvokeResult = { ok: true };
    await cmdSend("plugin:hello-package", "test");

    expect(exitCode).toBeUndefined();
    expect(consoleOut.some(l => l.includes("(no output)"))).toBe(true);
  });

  test("unknown plugin name exits with error", async () => {
    await expect(
      cmdSend("plugin:does-not-exist", "test"),
    ).rejects.toThrow("process.exit");

    expect(exitCode).toBe(1);
    expect(consoleErr.some(l => l.includes("plugin not found: does-not-exist"))).toBe(true);
  });

  test("non-plugin: prefix still routes normally (no regression)", async () => {
    // "mawjs" has no plugin: prefix — falls through to normal routing
    // resolveTarget returns error type → cmdSend exits with error (not a plugin error)
    await expect(
      cmdSend("mawjs", "hello"),
    ).rejects.toThrow("process.exit");

    expect(exitCode).toBe(1);
    // Must NOT print "plugin not found"
    expect(consoleErr.some(l => l.includes("plugin not found"))).toBe(false);
  });
});
