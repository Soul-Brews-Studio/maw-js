/**
 * WASM command loader — instantiates .wasm plugins with the host bridge.
 *
 * Internal module — re-exported by ./command-registry.ts barrel.
 * Split from command-registry.ts as part of the ≤200 LOC seam work.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { loadManifestFromDir } from "../plugin/manifest";
import { buildImportObject } from "./wasm-bridge";
import { registerCommand } from "./command-registry-match";
import {
  WASM_MEMORY_MAX_PAGES,
  wasmInstances,
} from "./command-registry-types";

/**
 * Load a WASM command plugin. Expects exports: handle(ptr, len) + memory.
 * Optionally exports command_name/command_desc globals for metadata.
 * Host functions (maw_print, maw_identity, etc.) are injected via importObject.
 */
export async function loadWasmCommand(path: string, filename: string, scope: "builtin" | "user", disabled: string[] = []): Promise<void> {
  const wasmBytes = readFileSync(path);
  const mod = new WebAssembly.Module(wasmBytes);
  const exports = WebAssembly.Module.exports(mod);
  const exportNames = exports.map((e: { name: string }) => e.name);

  // Must have handle + memory
  if (!exportNames.includes("handle") || !exportNames.includes("memory")) {
    console.log(`[commands] skipped wasm: ${filename} (no handle+memory exports)`);
    return;
  }

  // Late-binding refs — the instance isn't created yet when we build the bridge
  let wasmMemory: WebAssembly.Memory;
  let wasmAlloc: (size: number) => number;

  const bridge = buildImportObject(
    () => wasmMemory,
    () => wasmAlloc,
    { memoryMaxPages: WASM_MEMORY_MAX_PAGES },
  );

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(mod, bridge);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message?.slice(0, 120) : String(err).slice(0, 120);
    console.error(`[commands] wasm instantiation failed: ${filename}: ${msg}`);
    return;
  }

  wasmMemory = instance.exports.memory as WebAssembly.Memory;
  wasmAlloc = (instance.exports.maw_alloc as (size: number) => number)
    ?? bridge.env.maw_alloc; // fallback to host-side bump allocator

  // Validate exported memory against safety limit
  const memoryPages = wasmMemory.buffer.byteLength / 65_536;
  if (memoryPages > WASM_MEMORY_MAX_PAGES) {
    console.error(
      `[commands] wasm rejected: ${filename} — initial memory (${memoryPages} pages) exceeds ${WASM_MEMORY_MAX_PAGES}-page limit`,
    );
    return;
  }

  const handle = instance.exports.handle as (ptr: number, len: number) => number;

  // Check for sibling plugin.json — if present and references this .wasm, use manifest metadata
  let manifestName: string | undefined;
  let manifestDescription: string | undefined;
  try {
    const loaded = loadManifestFromDir(dirname(path));
    if (loaded && resolve(loaded.wasmPath) === resolve(path)) {
      manifestName = loaded.manifest.cli?.command;
      manifestDescription = loaded.manifest.description;
    }
  } catch { /* no manifest or invalid — fall through to legacy */ }

  // Read command name from manifest > exports > filename stem
  const name = manifestName
    || (instance.exports.command_name as WebAssembly.Global)?.value
    || filename.replace(/\.wasm$/, "");

  // Skip disabled plugins
  if (disabled.includes(name)) return;

  const description = manifestDescription
    || (instance.exports.command_desc as WebAssembly.Global)?.value
    || `WASM command: ${filename}`;

  registerCommand(
    { name, description },
    path,
    scope,
  );

  // Store the instance for execution
  wasmInstances.set(path, { handle, memory: wasmMemory, instance, bridge });
  console.log(`[commands] loaded wasm: ${filename} (memory: ${memoryPages}/${WASM_MEMORY_MAX_PAGES} pages)`);
}
