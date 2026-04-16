/**
 * command-registry-execute.ts — WASM + TS/JS dispatch.
 *
 * Two dispatch branches:
 *   1. `.wasm` path: lookup wasmInstances[path] → preCacheBridge → memory-
 *      limit guard → alloc+write args → handle() → read result (length-
 *      prefixed OR null-terminated fallback) → all wrapped in a
 *      Promise.race([wasmExec, 5s timeoutGuard]) → categorise error
 *      (timeout / trap / memory / safety / generic) → evict instance.
 *   2. TS/JS path: dynamic `await import(desc.path)` → `mod.default ||
 *      mod.handler` → parseFlags (if desc.flags) → call handler.
 *
 * Isolated because we mock.module on:
 *   - src/cli/wasm-bridge   (preCacheBridge — stops real SDK calls to
 *                            maw.identity() / maw.federation())
 *
 * `wasmInstances` (from ./command-registry-types) is a process-wide Map —
 * we populate it per-test with a fake {handle, memory, instance, bridge}
 * triple and clear it in afterEach so the registry doesn't bleed.
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (#375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)`.
 * os.homedir() caching is N/A here (no home lookups).
 *
 * globalThis.setTimeout is stubbed during run() so the production code's
 * 5-second WASM timeoutGuard never fires mid-test (else it would reject
 * an orphan promise and leak into sibling suites). The stub returns a
 * dummy timer id and never invokes the callback; the wasmExec branch
 * settles first every time.
 */
import {
  describe, test, expect, mock, beforeAll, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const wasmBridgePath = join(import.meta.dir, "../../src/cli/wasm-bridge");
const _rBridge = await import("../../src/cli/wasm-bridge");
const realPreCacheBridge = _rBridge.preCacheBridge;

// ─── Mutable mock state (reset per-test) ────────────────────────────────────

let preCacheBridgeImpl: (bridge: unknown) => Promise<void> = async () => {};

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
const { executeCommand } = await import("../../src/cli/command-registry-execute");
const { wasmInstances } = await import("../../src/cli/command-registry-types");

// ─── stdout + stderr + setTimeout harness ───────────────────────────────────

const origLog = console.log;
const origErr = console.error;
const origSetTimeout = globalThis.setTimeout;

let outs: string[] = [];
let errs: string[] = [];

async function run(fn: () => Promise<void>): Promise<void> {
  outs = []; errs = [];
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  (globalThis as unknown as { setTimeout: () => number }).setTimeout =
    (() => 0) as unknown as typeof setTimeout;
  try { await fn(); }
  finally {
    console.log = origLog;
    console.error = origErr;
    (globalThis as unknown as { setTimeout: typeof origSetTimeout }).setTimeout =
      origSetTimeout;
  }
}

// ─── tmpdir for JS handler modules ──────────────────────────────────────────

let tmp: string;
let modSeq = 0;
function writeMod(src: string): string {
  const path = join(tmp, `mod_${++modSeq}_${Date.now()}.mjs`);
  writeFileSync(path, src);
  return path;
}

// ─── WASM fixture helpers ───────────────────────────────────────────────────

function makeMemory(bytes = 64 * 1024): WebAssembly.Memory {
  return { buffer: new ArrayBuffer(bytes) } as unknown as WebAssembly.Memory;
}

function setupWasm(opts: {
  path?: string;
  memory?: WebAssembly.Memory;
  handle: (ptr: number, len: number) => number;
  maw_alloc?: (size: number) => number;
}): string {
  const path = opts.path ?? `/fake/plug_${++modSeq}.wasm`;
  const memory = opts.memory ?? makeMemory();
  const exports = opts.maw_alloc !== undefined
    ? { maw_alloc: opts.maw_alloc }
    : {};
  wasmInstances.set(path, {
    handle: opts.handle,
    memory,
    instance: { exports } as unknown as WebAssembly.Instance,
    bridge: {} as never,
  });
  return path;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "cmdreg-exec-"));
});

beforeEach(() => {
  mockActive = true;
  preCacheBridgeImpl = async () => {};
  wasmInstances.clear();
});

afterEach(() => {
  mockActive = false;
  wasmInstances.clear();
});

afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origErr;
  (globalThis as unknown as { setTimeout: typeof origSetTimeout }).setTimeout =
    origSetTimeout;
  rmSync(tmp, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// TS/JS dispatch path
// ════════════════════════════════════════════════════════════════════════════

describe("executeCommand — TS/JS dispatch", () => {
  test("module with no default export and no handler → error + return", async () => {
    const path = writeMod(`export const unused = 1;`);
    await run(() => executeCommand({ name: "nada", description: "", path }, []));
    expect(errs.join("\n")).toContain("nada: no default export or handler");
  });

  test("default export is called with (positional, flags) when no flags spec", async () => {
    const capturePath = join(tmp, `cap_default_${Date.now()}.json`);
    const path = writeMod(`
      import { writeFileSync } from "fs";
      export default async function(positional, flags) {
        writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ positional, flags }));
      }
    `);
    await run(() => executeCommand({ name: "d", description: "", path }, ["x", "y"]));
    const cap = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(cap.positional).toEqual(["x", "y"]);
    expect(cap.flags).toEqual({ _: ["x", "y"] });
  });

  test("named `handler` export is used when default is missing", async () => {
    const capturePath = join(tmp, `cap_handler_${Date.now()}.json`);
    const path = writeMod(`
      import { writeFileSync } from "fs";
      export async function handler(positional, flags) {
        writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ positional, flags }));
      }
    `);
    await run(() => executeCommand({ name: "h", description: "", path }, ["a"]));
    const cap = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(cap.positional).toEqual(["a"]);
  });

  test("desc.flags → parseFlags wiring populates typed flags", async () => {
    const capturePath = join(tmp, `cap_flags_${Date.now()}.json`);
    const path = writeMod(`
      import { writeFileSync } from "fs";
      export default async function(positional, flags) {
        writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ positional, flags }));
      }
    `);
    await run(() => executeCommand(
      { name: "f", description: "", path, flags: { "--verbose": Boolean, "--name": String } },
      ["pos1", "--verbose", "--name", "oracle"],
    ));
    const cap = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(cap.positional).toEqual(["pos1"]);
    expect(cap.flags["--verbose"]).toBe(true);
    expect(cap.flags["--name"]).toBe("oracle");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WASM dispatch — lookup / memory guard
// ════════════════════════════════════════════════════════════════════════════

describe("executeCommand — WASM lookup + memory guard", () => {
  test("no instance registered for desc.path → error + return (no handle call)", async () => {
    await run(() => executeCommand(
      { name: "missing", description: "", path: "/no/such.wasm" },
      [],
    ));
    expect(errs.join("\n")).toContain("WASM instance not found: /no/such.wasm");
  });

  test("memory buffer exceeds 256-page limit → error + instance evicted", async () => {
    // 257 pages × 64KB = 16.8MB, one page over the 16MB limit.
    const overflow = makeMemory(257 * 65_536);
    let handleCalled = false;
    const path = setupWasm({
      memory: overflow,
      handle: () => { handleCalled = true; return 0; },
    });
    await run(() => executeCommand({ name: "big", description: "", path }, []));
    expect(errs.join("\n")).toContain("WASM memory exceeded 256-page limit");
    expect(handleCalled).toBe(false);
    expect(wasmInstances.has(path)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WASM dispatch — successful handle paths
// ════════════════════════════════════════════════════════════════════════════

describe("executeCommand — WASM handle success paths", () => {
  test("length-prefixed result → logged to stdout; args round-trip via memory", async () => {
    const memory = makeMemory();
    const ARG_PTR = 8192;
    const RESULT_PTR = 16384;
    let seenArgs: unknown = null;
    const path = setupWasm({
      memory,
      maw_alloc: () => ARG_PTR,
      handle: (argPtr, argLen) => {
        const raw = new Uint8Array(memory.buffer, argPtr, argLen);
        seenArgs = JSON.parse(new TextDecoder().decode(raw));
        const payload = new TextEncoder().encode("hello from wasm");
        new DataView(memory.buffer).setUint32(RESULT_PTR, payload.length, true);
        new Uint8Array(memory.buffer).set(payload, RESULT_PTR + 4);
        return RESULT_PTR;
      },
    });
    await run(() => executeCommand({ name: "ok", description: "", path }, ["foo", "bar"]));
    expect(seenArgs).toEqual(["foo", "bar"]);
    expect(outs.join("\n")).toContain("hello from wasm");
    expect(errs).toEqual([]);
    // Instance survives a successful call.
    expect(wasmInstances.has(path)).toBe(true);
  });

  test("missing maw_alloc export → argPtr falls back to 0 (legacy modules)", async () => {
    const memory = makeMemory();
    let argPtrSeen = -1;
    const path = setupWasm({
      memory,
      // NO maw_alloc key on exports
      handle: (argPtr) => { argPtrSeen = argPtr; return 0; },
    });
    await run(() => executeCommand({ name: "noalloc", description: "", path }, []));
    expect(argPtrSeen).toBe(0);
  });

  test("null-terminated result fallback → decodes until \\0", async () => {
    const memory = makeMemory();
    const RESULT_PTR = 16384;
    const path = setupWasm({
      memory,
      maw_alloc: () => 8192,
      handle: () => {
        // Write "HELLO\0" at RESULT_PTR. First 4 bytes 'H','E','L','L' read as
        // u32 LE = 0x4c4c4548 ≈ 1.28G → > 1M → dispatcher falls through to the
        // null-terminator branch, which walks from RESULT_PTR until the 0 byte.
        const bytes = new TextEncoder().encode("HELLO\0");
        new Uint8Array(memory.buffer).set(bytes, RESULT_PTR);
        return RESULT_PTR;
      },
    });
    await run(() => executeCommand({ name: "nt", description: "", path }, []));
    expect(outs.join("\n")).toContain("HELLO");
  });

  test("handle returns 0 → nothing logged (output branch skipped)", async () => {
    const path = setupWasm({
      maw_alloc: () => 8192,
      handle: () => 0,
    });
    await run(() => executeCommand({ name: "zero", description: "", path }, []));
    expect(outs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("length-prefix len=0 takes fallback path, empty-string guard skips log", async () => {
    const memory = makeMemory();
    const RESULT_PTR = 16384;
    const path = setupWasm({
      memory,
      maw_alloc: () => 8192,
      handle: () => {
        // Zero u32 LE at RESULT_PTR → dispatcher enters null-term fallback.
        // Fallback starts reading at RESULT_PTR where byte[0] is already 0,
        // so result = "" and the `if (result)` guard skips the console.log.
        new DataView(memory.buffer).setUint32(RESULT_PTR, 0, true);
        return RESULT_PTR;
      },
    });
    await run(() => executeCommand({ name: "len0", description: "", path }, []));
    expect(outs).toEqual([]);
    expect(errs).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WASM dispatch — error categorisation + eviction
// ════════════════════════════════════════════════════════════════════════════

describe("executeCommand — WASM error branches", () => {
  test("timeout-shaped error → 'WASM timeout in' log + evict", async () => {
    preCacheBridgeImpl = async () => {
      throw new Error("[wasm-safety] timed out after 5s");
    };
    const path = setupWasm({ handle: () => 0 });
    await run(() => executeCommand({ name: "slow", description: "", path }, []));
    const joined = errs.join("\n");
    expect(joined).toContain(`WASM timeout in "slow"`);
    expect(joined).toContain("5s limit");
    expect(wasmInstances.has(path)).toBe(false);
  });

  test("'unreachable' in error → classified as WASM trap", async () => {
    const path = setupWasm({
      handle: () => { throw new Error("unreachable executed"); },
    });
    await run(() => executeCommand({ name: "trap", description: "", path }, []));
    expect(errs.join("\n")).toContain(`WASM trap in "trap"`);
    expect(wasmInstances.has(path)).toBe(false);
  });

  test("'RuntimeError' in error → classified as WASM trap", async () => {
    const path = setupWasm({
      handle: () => { throw new Error("RuntimeError: function signature mismatch"); },
    });
    await run(() => executeCommand({ name: "rterr", description: "", path }, []));
    expect(errs.join("\n")).toContain(`WASM trap in "rterr"`);
  });

  test("'out of bounds' in error → classified as WASM memory error", async () => {
    const path = setupWasm({
      handle: () => { throw new Error("memory access out of bounds"); },
    });
    await run(() => executeCommand({ name: "oob", description: "", path }, []));
    expect(errs.join("\n")).toContain(`WASM memory error in "oob"`);
  });

  test("'[wasm-safety]' without 'timed out' → safety-limit branch", async () => {
    preCacheBridgeImpl = async () => {
      throw new Error("[wasm-safety] maw_alloc denied: 300 pages would exceed 256-page limit");
    };
    const path = setupWasm({ handle: () => 0 });
    await run(() => executeCommand({ name: "safety", description: "", path }, []));
    const joined = errs.join("\n");
    expect(joined).toContain(`WASM safety limit in "safety"`);
    expect(joined).not.toContain("WASM timeout");
  });

  test("unclassified Error → catch-all 'WASM error in' branch", async () => {
    const path = setupWasm({
      handle: () => { throw new Error("kaboom"); },
    });
    await run(() => executeCommand({ name: "generic", description: "", path }, []));
    const joined = errs.join("\n");
    expect(joined).toContain(`WASM error in "generic"`);
    expect(joined).toContain("kaboom");
  });

  test("non-Error throw (bare string) → String(err) coercion in message", async () => {
    const path = setupWasm({
      handle: () => { throw "bare string" as unknown as Error; },
    });
    await run(() => executeCommand({ name: "bare", description: "", path }, []));
    expect(errs.join("\n")).toContain("bare string");
  });
});
