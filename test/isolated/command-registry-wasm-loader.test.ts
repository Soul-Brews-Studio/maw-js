/**
 * command-registry-wasm.ts — isolated WASM loader coverage.
 *
 * Uses tiny hand-crafted WASM modules so loadWasmCommand exercises the real
 * WebAssembly.Module/Instance path without compiling fixtures or touching the
 * broader command scanner. Registry state is reset around each test.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { loadWasmCommand } = await import("../../src/cli/command-registry-wasm");
const { commands, wasmInstances, WASM_MEMORY_MAX_PAGES } = await import("../../src/cli/command-registry-types");

// Exports memory + handle(i32,i32)->i32; handle returns 0. No imports.
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

// handle only, no memory export.
const WASM_NO_MEMORY = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

// memory only, no handle export.
const WASM_NO_HANDLE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x0a, 0x01,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

// Exports memory + handle, but imports env.missing_fn so instantiation fails.
const WASM_BAD_INSTANTIATE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x0a, 0x02,
    0x60, 0x00, 0x00,
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x02, 0x12, 0x01,
    0x03, 0x65, 0x6e, 0x76,
    0x0a, 0x6d, 0x69, 0x73, 0x73, 0x69, 0x6e, 0x67, 0x5f, 0x66, 0x6e,
    0x00, 0x00,
  0x03, 0x02, 0x01, 0x01,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x01,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

// Same as WASM_HANDLE_ZERO, but initial memory is 257 pages (> 256-page cap).
const WASM_BIG_MEMORY = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x00, 0x81, 0x02,
  0x07, 0x13, 0x02,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
    0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

let tmp: string;
let seq = 0;
const origLog = console.log;
const origError = console.error;
let logs: string[] = [];
let errors: string[] = [];

function writeWasm(bytes: Uint8Array, name = `plugin-${++seq}.wasm`): string {
  const path = join(tmp, name);
  writeFileSync(path, bytes);
  return path;
}

async function capture(fn: () => Promise<void>): Promise<void> {
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try { await fn(); }
  finally {
    console.log = origLog;
    console.error = origError;
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "cmdreg-wasm-"));
});

beforeEach(() => {
  commands.clear();
  wasmInstances.clear();
});

afterEach(() => {
  commands.clear();
  wasmInstances.clear();
  console.log = origLog;
  console.error = origError;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadWasmCommand", () => {
  test("skips valid wasm modules that do not export both handle and memory", async () => {
    const noMemory = writeWasm(WASM_NO_MEMORY, "no-memory.wasm");
    const noHandle = writeWasm(WASM_NO_HANDLE, "no-handle.wasm");

    await capture(async () => {
      await loadWasmCommand(noMemory, "no-memory.wasm", "user");
      await loadWasmCommand(noHandle, "no-handle.wasm", "user");
    });

    expect(logs.join("\n")).toContain("skipped wasm: no-memory.wasm (no handle+memory exports)");
    expect(logs.join("\n")).toContain("skipped wasm: no-handle.wasm (no handle+memory exports)");
    expect(commands.size).toBe(0);
    expect(wasmInstances.size).toBe(0);
  });

  test("reports instantiation failures without registering or caching an instance", async () => {
    const path = writeWasm(WASM_BAD_INSTANTIATE, "bad-instantiate.wasm");

    await capture(() => loadWasmCommand(path, "bad-instantiate.wasm", "builtin"));

    expect(errors.join("\n")).toContain("wasm instantiation failed: bad-instantiate.wasm");
    expect(commands.size).toBe(0);
    expect(wasmInstances.has(path)).toBe(false);
  });

  test("rejects modules whose initial memory exceeds the safety cap", async () => {
    const path = writeWasm(WASM_BIG_MEMORY, "too-big.wasm");

    await capture(() => loadWasmCommand(path, "too-big.wasm", "user"));

    expect(errors.join("\n")).toContain(
      `wasm rejected: too-big.wasm — initial memory (${WASM_MEMORY_MAX_PAGES + 1} pages) exceeds ${WASM_MEMORY_MAX_PAGES}-page limit`,
    );
    expect(commands.size).toBe(0);
    expect(wasmInstances.has(path)).toBe(false);
  });

  test("registers a default filename-stem command and caches the executable instance", async () => {
    const path = writeWasm(WASM_HANDLE_ZERO, "hello-tool.wasm");

    await capture(() => loadWasmCommand(path, "hello-tool.wasm", "builtin"));

    const registered = commands.get("hello-tool");
    expect(registered?.path).toBe(path);
    expect(registered?.desc).toMatchObject({
      name: "hello-tool",
      description: "WASM command: hello-tool.wasm",
      path,
      scope: "builtin",
    });
    const cached = wasmInstances.get(path);
    expect(cached?.handle(0, 0)).toBe(0);
    expect(cached?.memory.buffer.byteLength).toBe(65_536);
    const identityPtr = cached!.bridge.env.maw_identity();
    const identityLen = new DataView(cached!.memory.buffer).getUint32(identityPtr, true);
    const identity = new TextDecoder().decode(new Uint8Array(cached!.memory.buffer, identityPtr + 4, identityLen));
    expect(identity).toBe('{"error":"identity not pre-cached"}');
    expect(logs.join("\n")).toContain(`loaded wasm: hello-tool.wasm (memory: 1/${WASM_MEMORY_MAX_PAGES} pages)`);
  });

  test("uses sibling plugin.json metadata when it points at the loaded wasm", async () => {
    const wasmPath = writeWasm(WASM_HANDLE_ZERO, "manifest-tool.wasm");
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify({
      name: "manifest-tool",
      version: "1.0.0",
      sdk: "*",
      wasm: "manifest-tool.wasm",
      cli: { command: "manifest cmd" },
      description: "Manifest supplied description",
    }));

    await capture(() => loadWasmCommand(wasmPath, "manifest-tool.wasm", "user"));

    expect(commands.get("manifest cmd")?.desc).toMatchObject({
      name: "manifest cmd",
      description: "Manifest supplied description",
      path: wasmPath,
      scope: "user",
    });
    expect(wasmInstances.has(wasmPath)).toBe(true);
  });

  test("honors disabled command names after manifest/filename resolution", async () => {
    const path = writeWasm(WASM_HANDLE_ZERO, "disabled-tool.wasm");

    await capture(() => loadWasmCommand(path, "disabled-tool.wasm", "user", ["disabled-tool"]));

    expect(commands.size).toBe(0);
    expect(wasmInstances.has(path)).toBe(false);
    expect(logs.join("\n")).not.toContain("loaded wasm: disabled-tool.wasm");
  });
});
