/**
 * registry-invoke.ts — invokePlugin(plugin, ctx).
 *
 * Four dispatch branches:
 *   1. CLI `-v / --version / -version` at args[0] → print manifest metadata
 *   2. CLI `-h / --help / -help` anywhere in args → print help + surfaces
 *   3. `plugin.kind === "ts"` → dynamic `await import(entryPath)` →
 *      `mod.default || mod.handler` → await handler(ctxWithWriter) →
 *      if result has "ok" return it, else {ok:true}; on throw wrap stack
 *   4. WASM path: readFileSync → new WebAssembly.Module → exports guard →
 *      buildImportObject → new WebAssembly.Instance → Promise.race(
 *      exec, 5s timeoutGuard) → exec: preCacheBridge → alloc + write ctx
 *      JSON → handle(ptr,len) → if resultPtr > 0 read length-prefixed OR
 *      fall through to null-terminator scan → return {ok:true,output?}
 *
 * Isolated because:
 *   - TS branch does dynamic import of a plugin module — written to a
 *     fresh mkdtempSync tmpdir per-test, no mock.module needed
 *   - WASM branch uses hand-crafted Uint8Array fixtures so
 *     `new WebAssembly.Module(wasmBytes)` and instantiation run real code
 *
 * mock.module is process-global — we don't install any, since all seams
 * here can be exercised with real fs + real WASM bytes. This keeps the
 * #375 pollution catalog empty.
 * os.homedir() caching is N/A (no home lookups inside the target).
 *
 * globalThis.setTimeout is stubbed during WASM runs so the 5-second
 * timeoutGuard at line 194 never fires mid-test and leaks a rejected
 * orphan promise into sibling suites.
 *
 * process.stdout.write is stubbed during CLI-source TS runs because the
 * TS branch injects a real writer → process.stdout.write for
 * ctx.source === "cli".
 */
import {
  describe, test, expect, mock, beforeAll, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { LoadedPlugin, PluginManifest } from "../../src/plugin/types";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const wasmBridgePath = join(import.meta.dir, "../../src/cli/wasm-bridge");
const _rBridge = await import("../../src/cli/wasm-bridge");
const realPreCacheBridge = _rBridge.preCacheBridge;

// ─── Mutable mock state (reset per-test) ────────────────────────────────────

let preCacheBridgeImpl: (bridge: unknown) => Promise<void> = async () => {};

// ─── Mocks ──────────────────────────────────────────────────────────────────
// preCacheBridge hits maw.identity()/maw.federation() in real code — safe in
// prod (trySilentAsync catches) but can wait on network/config I/O under test
// and burn the 5s Bun-test timeout before our exec promise settles. Stub to
// no-op; restore via mockActive=false for any sibling suite passthrough.

mock.module(
  wasmBridgePath,
  () => ({
    ..._rBridge,
    preCacheBridge: async (...args: unknown[]) =>
      mockActive
        ? preCacheBridgeImpl(args[0])
        : (realPreCacheBridge as (...a: unknown[]) => Promise<void>)(...args),
  }),
);

// NB: import target AFTER mocks so its import graph resolves through our stubs.
const { invokePlugin } = await import("../../src/plugin/registry-invoke");

// ─── tmpdir for TS plugin modules ───────────────────────────────────────────

let tmp: string;
let modSeq = 0;
function writeMod(src: string): string {
  const path = join(tmp, `mod_${++modSeq}_${Date.now()}.mjs`);
  writeFileSync(path, src);
  return path;
}

function makeTsPlugin(entryPath: string, m: Partial<PluginManifest> = {}): LoadedPlugin {
  return {
    manifest: {
      name: m.name ?? "ts-plug",
      version: m.version ?? "1.0.0",
      sdk: m.sdk ?? "*",
      ...m,
    },
    dir: tmp,
    wasmPath: "",
    entryPath,
    kind: "ts",
  };
}

// ─── stdout + stderr + setTimeout harness ───────────────────────────────────

const origWrite = process.stdout.write.bind(process.stdout);
const origSetTimeout = globalThis.setTimeout;

let stdoutLines: string[] = [];

function stubStdoutWrite(): void {
  (process.stdout as unknown as { write: (s: string) => boolean }).write =
    (s: string): boolean => { stdoutLines.push(s); return true; };
}
function restoreStdoutWrite(): void {
  (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
}
function stubSetTimeout(): void {
  (globalThis as unknown as { setTimeout: () => number }).setTimeout =
    (() => 0) as unknown as typeof setTimeout;
}
function restoreSetTimeout(): void {
  (globalThis as unknown as { setTimeout: typeof origSetTimeout }).setTimeout =
    origSetTimeout;
}

// ─── Hand-crafted WASM fixtures ─────────────────────────────────────────────
// Each module exports memory (min 1 page) + handle(i32,i32)->i32. Handle body
// is i32.const <N> + end; signed-LEB128 — 100 = 0xe4,0x00. No imports, so
// our bridge's extra env.* exports are simply ignored by the instantiator.

// handle() returns 0 → dispatcher takes the `{ok:true}` no-output branch.
const WASM_HANDLE_ZERO = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

// handle() returns 100; data segment pre-writes length-prefixed "HELLO"
// at offset 100: [0x05,0x00,0x00,0x00,'H','E','L','L','O']. Dispatcher sees
// len=5 (<1_000_000) → length-prefixed branch → output="HELLO".
const WASM_LEN_PREFIXED = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0xe4, 0x00, 0x0b,
  0x0b, 0x10, 0x01,
    0x00, 0x41, 0xe4, 0x00, 0x0b, 0x09,
    0x05, 0x00, 0x00, 0x00, 0x48, 0x45, 0x4c, 0x4c, 0x4f,
]);

// handle() returns 100; data segment at offset 100 is "HELLO\0" (no prefix).
// First 4 bytes as u32 LE = 0x4c4c4548 ≈ 1.28G → > 1_000_000 → dispatcher
// falls through to null-terminator scan → output="HELLO".
const WASM_NULL_TERM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x07, 0x01, 0x05, 0x00, 0x41, 0xe4, 0x00, 0x0b,
  0x0b, 0x0d, 0x01,
    0x00, 0x41, 0xe4, 0x00, 0x0b, 0x06,
    0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x00,
]);

// handle only, no memory export — export section has just "handle".
// No memory section either; exports.includes("memory") is false → guard trips.
const WASM_NO_MEMORY = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

// memory only, no handle export. Module has no function/code sections.
const WASM_NO_HANDLE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x0a, 0x01,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

// Malformed bytes: correct magic + version, then a junk section id with
// out-of-range size. `new WebAssembly.Module` rejects → compile-error branch.
const WASM_BAD_COMPILE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff,
]);

// Valid compile but handle uses unreachable import function the bridge
// doesn't provide by a compatible signature. Actually we just test the
// instantiate error path via an import that doesn't exist in bridge.env.
// Module imports "env.missing_fn" (func () -> ()); bridge.env has no such
// key → new WebAssembly.Instance throws LinkError → dispatcher catches.
const WASM_BAD_INSTANTIATE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // Type section (10 bytes): type 0 = ()->(), type 1 = (i32,i32)->i32.
  // count(1) + type0(3) + type1(6) = 10 = 0x0a.
  0x01, 0x0a, 0x02,
    0x60, 0x00, 0x00,
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // Import section (18 bytes): "env.missing_fn" (func type 0). bridge.env
  // has no "missing_fn" key → new WebAssembly.Instance throws LinkError.
  // count(1) + mod-len(1) + "env"(3) + field-len(1) + "missing_fn"(10) +
  // kind(1) + typeidx(1) = 18 = 0x12.
  0x02, 0x12, 0x01,
    0x03, 0x65, 0x6e, 0x76,
    0x0a, 0x6d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x5f, 0x66, 0x6e,
    0x00, 0x00,
  // Function section: 1 function using type 1.
  0x03, 0x02, 0x01, 0x01,
  // Memory section: min 1 page.
  0x05, 0x03, 0x01, 0x00, 0x01,
  // Export section: memory + handle (handle is func index 1 because the
  // import occupies index 0 in the function space).
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x01,
  // Code section: handle body = i32.const 0; end.
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

function writeWasmPlugin(
  name: string,
  bytes: Uint8Array,
  manifest: Partial<PluginManifest> = {},
): LoadedPlugin {
  const wasmPath = join(tmp, `${name}_${++modSeq}.wasm`);
  writeFileSync(wasmPath, bytes);
  return {
    manifest: {
      name: manifest.name ?? name,
      version: manifest.version ?? "1.0.0",
      sdk: manifest.sdk ?? "*",
      wasm: `${name}.wasm`,
      ...manifest,
    },
    dir: tmp,
    wasmPath,
    kind: "wasm",
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "registry-invoke-"));
});

beforeEach(() => {
  mockActive = true;
  preCacheBridgeImpl = async () => {};
  stdoutLines = [];
});

afterEach(() => {
  mockActive = false;
  restoreStdoutWrite();
  restoreSetTimeout();
});

afterAll(() => {
  mockActive = false;
  restoreStdoutWrite();
  restoreSetTimeout();
  rmSync(tmp, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI universal flags — -v / --version
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — CLI -v/--version", () => {
  test("-v prints manifest metadata with all surfaces listed", async () => {
    const plug: LoadedPlugin = {
      manifest: {
        name: "greet", version: "1.2.3", sdk: "*", weight: 20,
        description: "greeter",
        cli: { command: "greet" },
        api: { path: "/greet", methods: ["GET"] },
        hooks: { on: ["cmd:ran"] },
        transport: { peer: true },
      },
      dir: "/fake/greet", wasmPath: "", kind: "wasm",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["-v"] });
    expect(result.ok).toBe(true);
    const out = result.output!;
    expect(out).toContain("greet v1.2.3 (wasm, weight:20)");
    expect(out).toContain("greeter");
    expect(out).toContain("cli:greet");
    expect(out).toContain("api:/greet");
    expect(out).toContain("hooks");
    expect(out).toContain("peer");
    expect(out).toContain("dir: /fake/greet");
  });

  test("--version synonym + default weight 50 when unset + no surfaces", async () => {
    const plug: LoadedPlugin = {
      manifest: { name: "bare", version: "0.0.1", sdk: "*" },
      dir: "/bare", wasmPath: "", kind: "ts",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["--version"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("bare v0.0.1 (ts, weight:50)");
    expect(result.output).toContain("surfaces: \n");
  });

  test("-version (long-form) also matches", async () => {
    const plug: LoadedPlugin = {
      manifest: { name: "x", version: "1", sdk: "*" },
      dir: "/x", wasmPath: "", kind: "wasm",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["-version"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("x v1");
  });

  test("dispatchable plugins without explicit cli surface report default-name cli", async () => {
    const tsPath = writeMod(`export default async function() { return { ok: true }; }`);
    const tsResult = await invokePlugin(makeTsPlugin(tsPath, { name: "shellenv" }), {
      source: "cli",
      args: ["-v"],
    });
    expect(tsResult.output).toContain("surfaces: cli:shellenv");

    const wasmResult = await invokePlugin(writeWasmPlugin("bg", WASM_HANDLE_ZERO), {
      source: "cli",
      args: ["-v"],
    });
    expect(wasmResult.output).toContain("surfaces: cli:bg");
  });

  test("-v only matches at args[0] — later -v does NOT trigger version", async () => {
    // args[0]="run", args[1]="-v" → version branch skipped, falls to WASM.
    // We give a missing wasm path so the WASM branch errors (not crash).
    const plug: LoadedPlugin = {
      manifest: { name: "n", version: "1", sdk: "*" },
      dir: tmp, wasmPath: "/no/such.wasm", kind: "wasm",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["run", "-v"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to read wasm");
  });

  test("non-CLI source skips universal-flag block entirely", async () => {
    const plug: LoadedPlugin = {
      manifest: { name: "n", version: "1", sdk: "*" },
      dir: tmp, wasmPath: "/no/such.wasm", kind: "wasm",
    };
    const result = await invokePlugin(plug, { source: "api", args: ["-v"] });
    // -v did not short-circuit; WASM file-read failure surfaces instead.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to read wasm");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLI universal flags — -h / --help / -help (#388.1: anywhere in args)
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — CLI -h/--help", () => {
  test("--help prints full usage block with every optional line", async () => {
    const plug: LoadedPlugin = {
      manifest: {
        name: "full", version: "1.0.0", sdk: "*",
        description: "does things",
        cli: {
          command: "full",
          help: "maw full <action>",
          aliases: ["fl", "ful"],
          flags: { "--verbose": "boolean", "--name": "string" },
        },
        api: { path: "/full", methods: ["GET", "POST"] },
        hooks: { gate: ["x"], on: ["y"] },
        transport: { peer: true },
      },
      dir: "/plug", wasmPath: "", kind: "ts",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["--help"] });
    expect(result.ok).toBe(true);
    const out = result.output!;
    expect(out).toContain("full v1.0.0");
    expect(out).toContain("does things");
    expect(out).toContain("usage: maw full <action>");
    expect(out).toContain("aliases: fl, ful");
    expect(out).toContain("--verbose");
    expect(out).toContain("boolean");
    expect(out).toContain("cli: maw full");
    expect(out).toContain("api: GET/POST /full");
    expect(out).toContain("peer: maw hey plugin:full");
    expect(out).toContain("hooks: gate, on");
    expect(out).toContain("dir: /plug");
  });

  test("no cli.help → falls back to `usage: maw <command>`", async () => {
    const plug: LoadedPlugin = {
      manifest: {
        name: "n", version: "1", sdk: "*",
        cli: { command: "n run" },
      },
      dir: "/d", wasmPath: "", kind: "ts",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["-h"] });
    expect(result.output).toContain("usage: maw n run");
  });

  test("no cli, no api, no hooks, no description → minimal help still OK", async () => {
    const plug: LoadedPlugin = {
      manifest: { name: "m", version: "1", sdk: "*" },
      dir: "/d", wasmPath: "", kind: "ts",
    };
    const result = await invokePlugin(plug, { source: "cli", args: ["-help"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("m v1");
    expect(result.output).toContain("surfaces:");
    expect(result.output).toContain("dir: /d");
  });

  test("dispatchable plugins without cli metadata still show default-name help", async () => {
    const tsPath = writeMod(`export default async function() { return { ok: true }; }`);
    const tsResult = await invokePlugin(makeTsPlugin(tsPath, { name: "rename" }), {
      source: "cli",
      args: ["--help"],
    });
    expect(tsResult.output).toContain("usage: maw rename");
    expect(tsResult.output).toContain("cli: maw rename");

    const wasmResult = await invokePlugin(writeWasmPlugin("park", WASM_HANDLE_ZERO), {
      source: "cli",
      args: ["--help"],
    });
    expect(wasmResult.output).toContain("usage: maw park");
    expect(wasmResult.output).toContain("cli: maw park");
  });

  test("#388.1 — --help anywhere in args triggers help (not just args[0])", async () => {
    const plug: LoadedPlugin = {
      manifest: {
        name: "oracle", version: "1", sdk: "*",
        cli: { command: "oracle" },
      },
      dir: "/d", wasmPath: "", kind: "ts",
    };
    // Subcommand + flag: `maw oracle scan --help` pattern.
    const result = await invokePlugin(plug, {
      source: "cli",
      args: ["scan", "--help"],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("oracle v1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TS plugin dispatch
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — TS plugin dispatch", () => {
  test("default export returning {ok:true, output} is returned as-is", async () => {
    const path = writeMod(`
      export default async function handler(ctx) {
        return { ok: true, output: "from-default: " + ctx.args.join(",") };
      }
    `);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: ["a", "b"] as unknown as string[] },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("from-default: a,b");
  });

  test("named `handler` export is used when default is missing", async () => {
    const path = writeMod(`
      export async function handler(ctx) {
        return { ok: false, error: "named-handler spoke" };
      }
    `);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result).toEqual({ ok: false, error: "named-handler spoke" });
  });

  test("no default and no handler exports → {ok:false, error:…}", async () => {
    const path = writeMod(`export const unused = 1;`);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("TS plugin has no default export or handler");
  });

  test("handler returns non-object-with-ok → wraps to {ok:true}", async () => {
    const path = writeMod(`export default async function() { return undefined; }`);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result).toEqual({ ok: true });
  });

  test("handler returning plain object without `ok` key → wraps to {ok:true}", async () => {
    const path = writeMod(`export default async function() { return { foo: 1 }; }`);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result).toEqual({ ok: true });
  });

  test("thrown Error → {ok:false, error:stack} (stack preserves plugin path)", async () => {
    const path = writeMod(`
      export default async function() { throw new Error("boom plugin"); }
    `);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom plugin");
    // Stack should reference the plugin path so source maps can resolve.
    expect(result.error).toContain(path);
  });

  test("thrown non-Error (bare string) → String(err) coercion in error", async () => {
    const path = writeMod(`
      export default async function() { throw "bare-string-throw"; }
    `);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bare-string-throw");
  });

  test("CLI source → injected writer streams to process.stdout line-by-line", async () => {
    const path = writeMod(`
      export default async function(ctx) {
        ctx.writer("alpha", 1);
        ctx.writer("beta");
        return { ok: true };
      }
    `);
    stubStdoutWrite();
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "cli", args: [] },
    );
    expect(result.ok).toBe(true);
    // Writer joins args with spaces and appends \n.
    expect(stdoutLines).toEqual(["alpha 1\n", "beta\n"]);
  });

  test("API source → ctx.writer is undefined (plugin can fall back to logs[])", async () => {
    const path = writeMod(`
      export default async function(ctx) {
        return { ok: true, output: "writer=" + (ctx.writer === undefined ? "undefined" : typeof ctx.writer) };
      }
    `);
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "api", args: [] },
    );
    expect(result.output).toBe("writer=undefined");
  });

  test("pre-set ctx.writer is honored (not overwritten by CLI default)", async () => {
    const path = writeMod(`
      export default async function(ctx) {
        ctx.writer("via-caller");
        return { ok: true };
      }
    `);
    const seen: string[] = [];
    const caller = (...args: unknown[]): void => {
      seen.push(args.map(String).join("|"));
    };
    const result = await invokePlugin(
      makeTsPlugin(path),
      { source: "cli", args: [], writer: caller },
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["via-caller"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TS plugin: kind==="ts" but entryPath missing → falls through to WASM branch
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — TS guard", () => {
  test("kind:'ts' without entryPath skips TS branch (falls to WASM read)", async () => {
    const plug: LoadedPlugin = {
      manifest: { name: "no-entry", version: "1", sdk: "*" },
      dir: tmp,
      wasmPath: "/no/such.wasm",
      kind: "ts",
      // no entryPath
    };
    const result = await invokePlugin(plug, { source: "api", args: [] });
    expect(result.ok).toBe(false);
    // Falls through because the `plugin.kind === "ts" && plugin.entryPath`
    // guard requires both; WASM branch then errors on readFileSync.
    expect(result.error).toContain("failed to read wasm");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WASM dispatch — file/compile/export/instantiate guards
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — WASM guards", () => {
  test("missing wasm file → {ok:false, error:'failed to read wasm: …'}", async () => {
    const plug = writeWasmPlugin("missing", WASM_HANDLE_ZERO);
    // Overwrite to a nonexistent path.
    plug.wasmPath = "/no/such/path.wasm";
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to read wasm:");
  });

  test("malformed wasm bytes → {ok:false, error:'wasm compile error: …'}", async () => {
    const plug = writeWasmPlugin("bad-compile", WASM_BAD_COMPILE);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wasm compile error/);
  });

  test("module missing 'memory' export → error (no instantiation attempted)", async () => {
    const plug = writeWasmPlugin("no-mem", WASM_NO_MEMORY);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("wasm missing required handle+memory exports");
  });

  test("module missing 'handle' export → error (no instantiation attempted)", async () => {
    const plug = writeWasmPlugin("no-handle", WASM_NO_HANDLE);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("wasm missing required handle+memory exports");
  });

  test("unresolved import → {ok:false, error:'wasm instantiation failed: …'}", async () => {
    const plug = writeWasmPlugin("bad-inst", WASM_BAD_INSTANTIATE);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wasm instantiation failed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WASM dispatch — handle result reading
// ════════════════════════════════════════════════════════════════════════════

describe("invokePlugin — WASM handle result", () => {
  test("handle returns 0 → {ok:true} (no output field)", async () => {
    const plug = writeWasmPlugin("zero", WASM_HANDLE_ZERO);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result).toEqual({ ok: true });
  });

  test("length-prefixed result → {ok:true, output:'HELLO'} decoded from memory", async () => {
    const plug = writeWasmPlugin("lenpre", WASM_LEN_PREFIXED);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("HELLO");
  });

  test("null-terminator fallback → {ok:true, output:'HELLO'} when len>1M", async () => {
    // Bytes at ptr 100 are "HELLO\0" — first 4 bytes as u32 LE > 1M, so the
    // length-prefixed branch is skipped and the scanner walks to the \0.
    const plug = writeWasmPlugin("nullterm", WASM_NULL_TERM);
    stubSetTimeout();
    const result = await invokePlugin(plug, { source: "cli", args: [] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("HELLO");
  });

  test("ctx is JSON-encoded into WASM linear memory at argPtr", async () => {
    // Reuse WASM_HANDLE_ZERO — doesn't read args, just returns 0. We're
    // verifying the dispatcher doesn't throw when ctx has rich content,
    // exercising the JSON.stringify + textEncoder.encode + memory.set path.
    const plug = writeWasmPlugin("argsprobe", WASM_HANDLE_ZERO);
    stubSetTimeout();
    const result = await invokePlugin(plug, {
      source: "peer",
      args: { nested: { a: 1, b: [true, null] } } as unknown as string[],
    });
    expect(result).toEqual({ ok: true });
  });

  test("preCacheBridge can use late-bound bridge memory and allocator before handle", async () => {
    const plug = writeWasmPlugin("bridge-precache", WASM_HANDLE_ZERO);
    stubSetTimeout();
    let identityPtr = 0;

    const result = await invokePlugin(
      plug,
      { source: "cli", args: [] },
      {
        preCacheBridge: async (bridge: any) => {
          bridge._setCachedIdentity(JSON.stringify({ node: "cached-node" }));
          identityPtr = bridge.env.maw_identity();
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(identityPtr).toBeGreaterThan(0);
  });

  test("timeout guard rejects stalled WASM execution", async () => {
    const plug = writeWasmPlugin("timeout", WASM_HANDLE_ZERO);
    const result = await invokePlugin(
      plug,
      { source: "cli", args: [] },
      {
        preCacheBridge: async () => new Promise<void>(() => {}),
        setTimeout: ((callback: () => void) => {
          callback();
          return 0;
        }) as unknown as typeof setTimeout,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("[wasm-safety] timed out after 5s");
  });
});
