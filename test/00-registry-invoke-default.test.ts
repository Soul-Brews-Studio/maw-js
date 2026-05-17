/**
 * Default-suite coverage for src/plugin/registry-invoke.ts.
 *
 * The 00- prefix is intentional: older default-suite API tests install a
 * process-global mock for ../src/plugin/registry. Loading the real invoke
 * module first keeps this focused helper coverage deterministic while the
 * deeper WASM cases remain isolated under test/isolated/.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { invokePlugin } from "../src/plugin/registry-invoke";
import type { InvokeContext, LoadedPlugin, PluginManifest } from "../src/plugin/types";

const tmp = mkdtempSync(join(tmpdir(), "maw-registry-invoke-default-"));
let seq = 0;

function writeModule(source: string): string {
  const path = join(tmp, `plugin-${++seq}-${Date.now()}.mjs`);
  writeFileSync(path, source);
  return path;
}

function tsPlugin(entryPath: string, manifest: Partial<PluginManifest> = {}): LoadedPlugin {
  return {
    manifest: {
      name: manifest.name ?? "plug",
      version: manifest.version ?? "1.0.0",
      sdk: manifest.sdk ?? "*",
      ...manifest,
    },
    dir: tmp,
    entryPath,
    wasmPath: "",
    kind: "ts",
  };
}

function wasmPlugin(manifest: Partial<PluginManifest> = {}): LoadedPlugin {
  return {
    manifest: {
      name: manifest.name ?? "wasm-plug",
      version: manifest.version ?? "1.0.0",
      sdk: manifest.sdk ?? "*",
      ...manifest,
    },
    dir: tmp,
    wasmPath: join(tmp, "missing.wasm"),
    kind: "wasm",
  };
}

function writeWasmPlugin(name: string, bytes: Uint8Array): LoadedPlugin {
  const wasmPath = join(tmp, `${name}-${++seq}.wasm`);
  writeFileSync(wasmPath, bytes);
  return {
    manifest: {
      name,
      version: "1.0.0",
      sdk: "*",
      wasm: `${name}.wasm`,
    },
    dir: tmp,
    wasmPath,
    kind: "wasm",
  };
}

const wasmDeps = {
  preCacheBridge: async () => {},
  setTimeout: (() => 0) as unknown as typeof setTimeout,
};

// handle() returns 0; exports memory + handle.
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

// handle() returns offset 100; data at offset 100 is u32 length + "HELLO".
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

// handle() returns offset 100; data at offset 100 is "HELLO\0", forcing
// the legacy null-terminated fallback because the first u32 is > 1_000_000.
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

const WASM_BAD_COMPILE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0xff,
]);

const WASM_NO_HANDLE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x0a, 0x01,
    0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
]);

beforeEach(() => {
  seq += 1;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("invokePlugin universal CLI metadata in the default suite", () => {
  test("--version reports effective surfaces including default-name TS CLI", async () => {
    const entry = writeModule(`export default async function handler() { return { ok: true }; }`);
    const result = await invokePlugin(
      tsPlugin(entry, {
        name: "surface",
        version: "2.3.4",
        description: "surface reporter",
        weight: 7,
        api: { path: "/api/surface", methods: ["GET"] },
        hooks: { on: ["message:send"] },
        transport: { peer: true },
      }),
      { source: "cli", args: ["--version"] },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("surface v2.3.4 (ts, weight:7)");
    expect(result.output).toContain("surface reporter");
    expect(result.output).toContain("cli:surface");
    expect(result.output).toContain("api:/api/surface");
    expect(result.output).toContain("hooks");
    expect(result.output).toContain("peer");
  });

  test("--help matches anywhere in args and renders declared CLI metadata", async () => {
    const entry = writeModule(`export const handler = async () => ({ ok: true });`);
    const result = await invokePlugin(
      tsPlugin(entry, {
        name: "helper",
        version: "1.0.1",
        description: "helpful plugin",
        cli: {
          command: "helper",
          help: "maw helper <thing>",
          aliases: ["hp"],
          flags: { "--name": "Name to render" },
        },
        api: { path: "/api/helper", methods: ["GET", "POST"] },
        hooks: { gate: ["cmd:before"] },
      }),
      { source: "cli", args: ["sub", "--help"] },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("helper v1.0.1");
    expect(result.output).toContain("helpful plugin");
    expect(result.output).toContain("usage: maw helper <thing>");
    expect(result.output).toContain("aliases: hp");
    expect(result.output).toContain("--name");
    expect(result.output).toContain("api: GET/POST /api/helper");
    expect(result.output).toContain("hooks: gate");
  });
});

describe("invokePlugin TS dispatch in the default suite", () => {
  test("returns handler InvokeResult objects as-is", async () => {
    const entry = writeModule(`
      export default async function handler(ctx) {
        return { ok: true, output: "args=" + ctx.args.join("|") };
      }
    `);

    const result = await invokePlugin(
      tsPlugin(entry),
      { source: "api", args: ["a", "b"] } satisfies InvokeContext,
    );

    expect(result).toEqual({ ok: true, output: "args=a|b" });
  });

  test("honors caller-provided writer instead of replacing it for CLI calls", async () => {
    const entry = writeModule(`
      export async function handler(ctx) {
        ctx.writer("sent", 42);
        return { ok: true };
      }
    `);
    const seen: string[] = [];

    const result = await invokePlugin(
      tsPlugin(entry),
      {
        source: "cli",
        args: [],
        writer: (...args: unknown[]) => seen.push(args.map(String).join(":")),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["sent:42"]);
  });

  test("missing handlers fail without falling through to WASM", async () => {
    const entry = writeModule(`export const nope = true;`);

    const result = await invokePlugin(tsPlugin(entry), { source: "api", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("TS plugin has no default export or handler");
  });

  test("thrown non-Error values are coerced into error results", async () => {
    const entry = writeModule(`export default async function handler() { throw "plain failure"; }`);

    const result = await invokePlugin(tsPlugin(entry), { source: "api", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("plain failure");
  });

  test("non-CLI calls skip universal flags and reach plugin execution", async () => {
    const result = await invokePlugin(wasmPlugin(), { source: "peer", args: ["--version"] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to read wasm");
  });
});

describe("invokePlugin WASM dispatch in the default suite", () => {
  test("malformed wasm bytes report a compile error", async () => {
    const result = await invokePlugin(writeWasmPlugin("bad", WASM_BAD_COMPILE), { source: "cli", args: [] }, wasmDeps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("wasm compile error");
  });

  test("modules without required memory+handle exports fail before instantiation", async () => {
    const result = await invokePlugin(writeWasmPlugin("no-handle", WASM_NO_HANDLE), { source: "cli", args: [] }, wasmDeps);

    expect(result).toEqual({ ok: false, error: "wasm missing required handle+memory exports" });
  });

  test("handle returning zero succeeds without output and writes rich context into memory", async () => {
    const result = await invokePlugin(
      writeWasmPlugin("zero", WASM_HANDLE_ZERO),
      { source: "peer", args: { nested: { a: 1, b: [true, null] } } as unknown as string[] },
      wasmDeps,
    );

    expect(result).toEqual({ ok: true });
  });

  test("length-prefixed wasm output is decoded", async () => {
    const result = await invokePlugin(writeWasmPlugin("len", WASM_LEN_PREFIXED), { source: "cli", args: [] }, wasmDeps);

    expect(result).toEqual({ ok: true, output: "HELLO" });
  });

  test("legacy null-terminated wasm output is decoded when length prefix is invalid", async () => {
    const result = await invokePlugin(writeWasmPlugin("null", WASM_NULL_TERM), { source: "cli", args: [] }, wasmDeps);

    expect(result).toEqual({ ok: true, output: "HELLO" });
  });
});
