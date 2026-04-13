/**
 * Plugin registry — discover plugin packages and invoke them.
 *
 * Scans two well-known directories for plugin packages (subdirs with plugin.json):
 *   ~/.maw/plugins/<name>/plugin.json
 *   ~/.oracle/commands/<name>/plugin.json
 *
 * Reuses wasm-bridge.ts infra (buildImportObject, preCacheBridge, readString, textEncoder).
 * Timeout: 5s hard limit matching command-registry.ts:193 pattern.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadManifestFromDir } from "./manifest";
import { loadConfig } from "../config";
import {
  buildImportObject,
  preCacheBridge,
  readString,
  textEncoder,
} from "../cli/wasm-bridge";
import type { LoadedPlugin, InvokeContext, InvokeResult } from "./types";

const PLUGIN_INVOKE_TIMEOUT_MS = 5_000;
const WASM_MEMORY_MAX_PAGES = 256; // 16MB

// Single scan dir — everything lives in ~/.maw/plugins/
// Core plugins auto-installed on `maw update` or first run.
const SCAN_DIRS = [
  join(homedir(), ".maw", "plugins"),
];

/**
 * Scan the two canonical plugin package directories and return all valid packages.
 * Each subdirectory is checked for a plugin.json manifest.
 * Silently skips directories with missing or invalid manifests.
 */
export function discoverPackages(): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];
  const disabled = loadConfig().disabledPlugins ?? [];

  for (const baseDir of SCAN_DIRS) {
    if (!existsSync(baseDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgDir = join(baseDir, entry);
      try {
        const loaded = loadManifestFromDir(pkgDir);
        if (loaded) {
          if (disabled.includes(loaded.manifest.name)) {
            loaded.disabled = true;
          }
          plugins.push(loaded);
        }
      } catch {
        // invalid manifest — skip silently
      }
    }
  }

  // Sort by weight (lower = first, default 50) — like Drupal module weight
  plugins.sort((a, b) => (a.manifest.weight ?? 50) - (b.manifest.weight ?? 50));

  return plugins;
}

/**
 * Instantiate a plugin's WASM module and call handle(ptr, len) with the context.
 * Context is JSON-encoded and written to shared memory; result is read back.
 * Hard 5-second timeout matches command-registry.ts:193.
 */
export async function invokePlugin(
  plugin: LoadedPlugin,
  ctx: InvokeContext,
): Promise<InvokeResult> {
  // Universal flags — every plugin gets these for free
  if (ctx.source === "cli") {
    const args = ctx.args as string[];
    const flag = args[0];
    const m = plugin.manifest;

    // -v / --version — show plugin metadata
    if (flag === "-v" || flag === "--version" || flag === "-version") {
      const surfaces = [
        m.cli ? `cli:${m.cli.command}` : null,
        m.api ? `api:${m.api.path}` : null,
        m.hooks ? "hooks" : null,
        m.transport?.peer ? "peer" : null,
      ].filter(Boolean).join(", ");
      return {
        ok: true,
        output: `${m.name} v${m.version} (${plugin.kind}, weight:${m.weight ?? 50})\n  ${m.description || ""}\n  surfaces: ${surfaces}\n  dir: ${plugin.dir}`,
      };
    }

    // -h / --help — show usage + flags + surfaces
    if (flag === "-h" || flag === "--help" || flag === "-help") {
      const lines: string[] = [];
      lines.push(`${m.name} v${m.version}`);
      if (m.description) lines.push(`  ${m.description}`);
      lines.push("");
      if (m.cli?.help) lines.push(`  usage: ${m.cli.help}`);
      else if (m.cli) lines.push(`  usage: maw ${m.cli.command}`);
      if (m.cli?.aliases?.length) lines.push(`  aliases: ${m.cli.aliases.join(", ")}`);
      if (m.cli?.flags) {
        lines.push("  flags:");
        for (const [k, v] of Object.entries(m.cli.flags)) lines.push(`    ${k.padEnd(20)} ${v}`);
      }
      lines.push("");
      lines.push("  surfaces:");
      if (m.cli) lines.push(`    cli: maw ${m.cli.command}`);
      if (m.api) lines.push(`    api: ${m.api.methods.join("/")} ${m.api.path}`);
      if (m.transport?.peer) lines.push(`    peer: maw hey plugin:${m.name}`);
      if (m.hooks) lines.push(`    hooks: ${Object.keys(m.hooks).join(", ")}`);
      lines.push(`\n  dir: ${plugin.dir}`);
      return { ok: true, output: lines.join("\n") };
    }
  }

  // TS plugins — import and call handler directly (full access)
  if (plugin.kind === "ts" && plugin.entryPath) {
    // Guard process.exit — cmd* functions call it on error. Convert to throw
    // so the handler's try/catch can capture the output and return it.
    const origExit = process.exit;
    process.exit = ((code?: number) => { throw Object.assign(new Error("exit"), { exitCode: code ?? 0 }); }) as any;

    try {
      const mod = await import(plugin.entryPath);
      const handler = mod.default || mod.handler;
      if (!handler) return { ok: false, error: "TS plugin has no default export or handler" };

      const result = await handler(ctx);
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    } finally {
      process.exit = origExit;
    }
  }

  // WASM plugins — instantiate and call handle(ptr, len) in sandbox
  let wasmBytes: Uint8Array;
  try {
    wasmBytes = readFileSync(plugin.wasmPath);
  } catch (err: any) {
    return { ok: false, error: `failed to read wasm: ${err.message}` };
  }

  // Compile
  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(wasmBytes);
  } catch (err: any) {
    return { ok: false, error: `wasm compile error: ${err.message}` };
  }

  const exportNames = WebAssembly.Module.exports(mod).map(
    (e: { name: string }) => e.name,
  );
  if (!exportNames.includes("handle") || !exportNames.includes("memory")) {
    return { ok: false, error: "wasm missing required handle+memory exports" };
  }

  // Late-binding refs (chicken-and-egg with memory/alloc exports)
  let wasmMemory!: WebAssembly.Memory;
  let wasmAlloc!: (size: number) => number;

  const bridge = buildImportObject(
    () => wasmMemory,
    () => wasmAlloc,
    { memoryMaxPages: WASM_MEMORY_MAX_PAGES },
  );

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(mod, bridge);
  } catch (err: any) {
    return { ok: false, error: `wasm instantiation failed: ${err.message}` };
  }

  wasmMemory = instance.exports.memory as WebAssembly.Memory;
  wasmAlloc =
    (instance.exports.maw_alloc as (size: number) => number) ??
    bridge.env.maw_alloc;

  const handle = instance.exports.handle as (ptr: number, len: number) => number;

  const exec = (async (): Promise<InvokeResult> => {
    // Pre-warm identity + federation caches (best-effort, won't throw)
    await preCacheBridge(bridge);

    // Write JSON-encoded context into shared memory
    const json = JSON.stringify(ctx);
    const bytes = textEncoder.encode(json);
    const argPtr =
      (instance.exports.maw_alloc as Function)?.(bytes.length) ?? 0;
    new Uint8Array(wasmMemory.buffer).set(bytes, argPtr);

    // Invoke handle(ptr, len) — matches command-registry.ts protocol
    const resultPtr = handle(argPtr, bytes.length);

    if (resultPtr > 0) {
      const view = new DataView(wasmMemory.buffer);
      const len = view.getUint32(resultPtr, true);
      if (len > 0 && len < 1_000_000) {
        // Length-prefixed protocol (u32 LE + UTF-8 payload)
        const output = readString(wasmMemory, resultPtr + 4, len);
        return { ok: true, ...(output ? { output } : {}) };
      }
      // Null-terminated fallback for legacy modules
      const raw = new Uint8Array(wasmMemory.buffer);
      let end = resultPtr;
      while (end < raw.length && raw[end] !== 0) end++;
      const output = new TextDecoder().decode(raw.slice(resultPtr, end));
      return { ok: true, ...(output ? { output } : {}) };
    }

    return { ok: true };
  })();

  // 5-second hard deadline — matches command-registry.ts:193
  const timeoutGuard = new Promise<InvokeResult>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `[wasm-safety] timed out after ${PLUGIN_INVOKE_TIMEOUT_MS / 1000}s`,
          ),
        ),
      PLUGIN_INVOKE_TIMEOUT_MS,
    ),
  );

  try {
    return await Promise.race([exec, timeoutGuard]);
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
