/**
 * Command dispatch — runs either a WASM or a TS/JS command plugin.
 *
 * Internal module — re-exported by ./command-registry.ts barrel.
 * Split from command-registry.ts as part of the ≤200 LOC seam work.
 */

import { parseFlags } from "./parse-args";
import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import {
  preCacheBridge, readString,
  textEncoder, textDecoder,
} from "./wasm-bridge";
import {
  WASM_MEMORY_MAX_PAGES,
  WASM_COMMAND_TIMEOUT_MS,
  wasmInstances,
  type CommandDescriptor,
} from "./command-registry-types";

/** Execute a matched command — lazy import + parseFlags + call handler */
export async function executeCommand(desc: CommandDescriptor, remaining: string[]): Promise<void> {
  if (desc.path?.endsWith(".wasm")) {
    const wasm = wasmInstances.get(desc.path!);
    if (!wasm) { console.error(`[commands] WASM instance not found: ${desc.path}`); return; }

    // Wrap WASM execution in a 5-second hard timeout via Promise.race
    const wasmExec = (async () => {
      // Pre-cache identity + federation so sync host functions return real data
      await preCacheBridge(wasm.bridge);

      // Validate memory hasn't grown beyond limit between calls
      if (wasm.memory.buffer.byteLength > WASM_MEMORY_MAX_PAGES * 65_536) {
        console.error(`[commands] WASM memory exceeded ${WASM_MEMORY_MAX_PAGES}-page limit — refusing to execute`);
        wasmInstances.delete(desc.path!);
        return;
      }

      // Write args as JSON to shared memory via allocator
      const json = JSON.stringify(remaining);
      const bytes = textEncoder.encode(json);
      const argPtr = (wasm.instance.exports.maw_alloc as Function)?.(bytes.length)
        ?? 0; // fallback: write at offset 0 for legacy modules
      new Uint8Array(wasm.memory.buffer).set(bytes, argPtr);

      // Call handle(ptr, len)
      const resultPtr = wasm.handle(argPtr, bytes.length);

      // Read result: if module uses length-prefixed protocol, read len from first 4 bytes
      if (resultPtr > 0) {
        const view = new DataView(wasm.memory.buffer);
        const len = view.getUint32(resultPtr, true);
        if (len > 0 && len < 1_000_000) {
          const result = readString(wasm.memory, resultPtr + 4, len);
          if (result) console.log(result);
        } else {
          // Fallback: null-terminated string (legacy modules)
          const raw = new Uint8Array(wasm.memory.buffer);
          let end = resultPtr;
          while (end < raw.length && raw[end] !== 0) end++;
          const result = textDecoder.decode(raw.slice(resultPtr, end));
          if (result) console.log(result);
        }
      }
    })();

    // 5-second hard deadline — rejects if preCacheBridge or handle() stalls
    const timeoutGuard = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[wasm-safety] timed out after ${WASM_COMMAND_TIMEOUT_MS / 1000}s`)),
        WASM_COMMAND_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([wasmExec, timeoutGuard]);
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes("wasm-safety") && msg.includes("timed out")) {
        console.error(`[commands] WASM timeout in "${desc.name}": command exceeded ${WASM_COMMAND_TIMEOUT_MS / 1000}s limit`);
      } else if (msg.includes("unreachable") || msg.includes("RuntimeError")) {
        console.error(`[commands] WASM trap in "${desc.name}": ${msg}`);
      } else if (msg.includes("out of bounds") || msg.includes("memory")) {
        console.error(`[commands] WASM memory error in "${desc.name}": ${msg}`);
      } else if (msg.includes("wasm-safety")) {
        console.error(`[commands] WASM safety limit in "${desc.name}": ${msg}`);
      } else {
        console.error(`[commands] WASM error in "${desc.name}": ${msg}`);
      }
      // Invalidate instance — state may be corrupted after a trap or timeout
      wasmInstances.delete(desc.path!);
    }
    return;
  }
  // Bun canary on macOS can lose later dynamic imports that come through the
  // /var → /private/var symlink. Import the canonical file URL so temporary
  // JS command modules load deterministically across runners.
  const mod = await import(pathToFileURL(realpathSync(desc.path!)).href);
  const handler = mod.default || mod.handler;
  if (!handler) { console.error(`[commands] ${desc.name}: no default export or handler`); return; }
  const flags = desc.flags ? parseFlags(["_", ...remaining], desc.flags, 1) : { _: remaining };
  await handler(flags._, flags);
}
