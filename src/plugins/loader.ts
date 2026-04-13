/**
 * Plugin loader — load TS/JS/WASM plugins from a directory.
 */

import type { PluginScope } from "./types";
import type { PluginSystem } from "./system";

/** Load a WASM plugin (shared-memory or WASI) */
async function loadWasmPlugin(system: PluginSystem, path: string, filename: string, source: PluginScope) {
  const { readFileSync } = require("fs");
  const wasmBytes = readFileSync(path);
  const mod = new WebAssembly.Module(wasmBytes);
  const exports = WebAssembly.Module.exports(mod);
  const exportNames = exports.map((e: { name: string }) => e.name);

  if (exportNames.includes("handle") && exportNames.includes("memory")) {
    const MAX_PAGES = 256;
    let instance: WebAssembly.Instance;
    try { instance = new WebAssembly.Instance(mod); }
    catch (err: any) { console.error(`[plugin] wasm failed: ${filename}: ${err.message?.slice(0, 120)}`); return; }

    const memory = instance.exports.memory as WebAssembly.Memory;
    const handle = instance.exports.handle as (ptr: number, len: number) => void;
    const encoder = new TextEncoder();

    if (memory.buffer.byteLength / 65_536 > MAX_PAGES) {
      console.error(`[plugin] wasm rejected: ${filename} — memory exceeds limit`);
      return;
    }

    system.load((hooks) => {
      hooks.on("*", (event) => {
        try {
          if (memory.buffer.byteLength > MAX_PAGES * 65_536) return;
          const json = encoder.encode(JSON.stringify(event));
          if (json.length > memory.buffer.byteLength) return;
          new Uint8Array(memory.buffer).set(json, 0);
          handle(0, json.length);
        } catch (err: any) {
          console.error(`[plugin] wasm trap in ${filename}: ${(err.message || err).slice(0, 120)}`);
        }
      });
    }, source);
    system.register(filename, "wasm-shared", source);
    return;
  }

  if (exportNames.includes("_start")) {
    const { WASI } = require("wasi");
    system.load((hooks) => {
      hooks.on("*", (event) => {
        try {
          const input = Buffer.from(`${JSON.stringify(event)}\n`);
          let pos = 0;
          const wasi = new WASI({
            version: "preview1",
            args: [filename, event.event],
            env: { MAW_EVENT: event.event, MAW_ORACLE: event.oracle, MAW_HOST: event.host },
            getStdin: () => { const c = input.subarray(pos, pos + 4096); pos += c.length; return c.length > 0 ? c : null; },
            sendStdout: (d: Buffer) => process.stdout.write(d),
            sendStderr: (d: Buffer) => process.stderr.write(d),
          });
          const inst = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
          wasi.start(inst);
        } catch {}
      });
    }, source);
    system.register(filename, "wasm-wasi", source);
    return;
  }
}

/** Load all plugins from a directory */
export async function loadPlugins(
  system: PluginSystem, dir: string, source: PluginScope = "user", cacheBust = false,
) {
  const { readdirSync } = require("fs");
  const { join } = require("path");
  let files: string[];
  try { files = readdirSync(dir).filter((f: string) => /\.(ts|js|wasm)$/.test(f)); }
  catch { return; }

  for (const file of files) {
    const path = join(dir, file);
    try {
      if (file.endsWith(".wasm")) {
        await loadWasmPlugin(system, path, file, source);
      } else {
        const spec = cacheBust ? `${path}?t=${Date.now()}` : path;
        const mod = await import(spec);
        const plugin = mod.default ?? mod;
        if (typeof plugin === "function") {
          system.load(plugin, source);
          system.register(file, file.endsWith(".ts") ? "ts" : "js", source);
        }
      }
    } catch (err) {
      console.error(`[plugin] failed to load ${file}:`, (err as Error).message);
    }
  }
}

/** Reload user plugins (hot-reload safe) */
export async function reloadUserPlugins(system: PluginSystem, dir: string) {
  system.unloadScope("user");
  await loadPlugins(system, dir, "user", true);
  system._markReloaded();
}
