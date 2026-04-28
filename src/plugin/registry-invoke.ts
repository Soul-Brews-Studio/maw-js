/**
 * invokePlugin — instantiate and call a plugin's handler.
 * Supports universal CLI flags (-v/--version, -h/--help), TS plugins, and
 * WASM plugins with a hard 5-second timeout.
 */

import { readFileSync } from "fs";
import {
  buildImportObject,
  preCacheBridge,
  readString,
  textEncoder,
} from "../cli/wasm-bridge";
import type { LoadedPlugin, InvokeContext, InvokeResult } from "./types";

const PLUGIN_INVOKE_TIMEOUT_MS = 5_000;
const WASM_MEMORY_MAX_PAGES = 256; // 16MB

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
      // #899 — derive the effective CLI surface so plugins without an
      // explicit `cli` field still report their default-name dispatch
      // (community-plugin shape: shellenv, bg, rename, cross-team-queue, park).
      const effectiveCli = m.cli?.command
        ?? (plugin.kind === "ts" && plugin.entryPath ? m.name : undefined)
        ?? (plugin.kind === "wasm" && plugin.wasmPath ? m.name : undefined);
      const surfaces = [
        effectiveCli ? `cli:${effectiveCli}` : null,
        m.api ? `api:${m.api.path}` : null,
        m.hooks ? "hooks" : null,
        m.transport?.peer ? "peer" : null,
      ].filter(Boolean).join(", ");
      return {
        ok: true,
        output: `${m.name} v${m.version} (${plugin.kind}, weight:${m.weight ?? 50})\n  ${m.description || ""}\n  surfaces: ${surfaces}\n  dir: ${plugin.dir}`,
      };
    }

    // -h / --help — show usage + flags + surfaces.
    // #388.1 — intercept anywhere in args, not just args[0], so
    // `maw <plugin> <sub> --help` shows help instead of running the
    // subcommand (e.g. `maw oracle scan --help`, `maw ui install --help`).
    if (args.some(a => a === "-h" || a === "--help" || a === "-help")) {
      const lines: string[] = [];
      lines.push(`${m.name} v${m.version}`);
      if (m.description) lines.push(`  ${m.description}`);
      lines.push("");
      // #899 — fall back to default-name dispatch when `cli` is omitted but
      // the plugin is dispatchable. Mirrors pluginCliNames() in dispatch-match.
      const defaultCli = (plugin.kind === "ts" && plugin.entryPath) || (plugin.kind === "wasm" && plugin.wasmPath)
        ? m.name
        : null;
      const effectiveCmd = m.cli?.command ?? defaultCli;
      if (m.cli?.help) lines.push(`  usage: ${m.cli.help}`);
      else if (effectiveCmd) lines.push(`  usage: maw ${effectiveCmd}`);
      if (m.cli?.aliases?.length) lines.push(`  aliases: ${m.cli.aliases.join(", ")}`);
      if (m.cli?.flags) {
        lines.push("  flags:");
        for (const [k, v] of Object.entries(m.cli.flags)) lines.push(`    ${k.padEnd(20)} ${v}`);
      }
      lines.push("");
      lines.push("  surfaces:");
      if (effectiveCmd) lines.push(`    cli: maw ${effectiveCmd}`);
      if (m.api) lines.push(`    api: ${m.api.methods.join("/")} ${m.api.path}`);
      if (m.transport?.peer) lines.push(`    peer: maw hey plugin:${m.name}`);
      if (m.hooks) lines.push(`    hooks: ${Object.keys(m.hooks).join(", ")}`);
      lines.push(`\n  dir: ${plugin.dir}`);
      return { ok: true, output: lines.join("\n") };
    }
  }

  // TS plugins — import and call handler directly (full access).
  //
  // NOTE: we deliberately do NOT monkey-patch process.exit anymore. The old
  // `process.exit → throw Error("exit")` patch swallowed real error stacks
  // and made plugin crashes opaque (sdk-consumer's Round 1 complaint). If a
  // plugin calls process.exit() it's now fatal to the host — which is the
  // honest behavior for Phase A (no sandbox).
  if (plugin.kind === "ts" && plugin.entryPath) {
    try {
      const mod = await import(plugin.entryPath);
      const handler = mod.default || mod.handler;
      if (!handler) return { ok: false, error: "TS plugin has no default export or handler" };

      // Inject writer based on ctx.source so plugins can stream to the
      // terminal in real-time (CLI) or fall back to logs[] capture (API/peer).
      // Callers (e.g. tests) may pre-set ctx.writer — we honor that.
      const ctxWithWriter: InvokeContext = {
        ...ctx,
        writer:
          ctx.writer ??
          (ctx.source === "cli"
            ? (...args: unknown[]) => {
                const line = args.map(String).join(" ");
                process.stdout.write(line + "\n");
              }
            : undefined),
      };

      const result = await handler(ctxWithWriter);
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: true };
    } catch (err: unknown) {
      // Preserve stack so Bun's source maps can resolve plugin frames.
      const e = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error: e.stack || e.message };
    }
  }

  // WASM plugins — instantiate and call handle(ptr, len) in sandbox
  let wasmBytes: Uint8Array;
  try {
    wasmBytes = readFileSync(plugin.wasmPath);
  } catch (err: unknown) {
    return { ok: false, error: `failed to read wasm: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Compile
  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(wasmBytes);
  } catch (err: unknown) {
    return { ok: false, error: `wasm compile error: ${err instanceof Error ? err.message : String(err)}` };
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
  } catch (err: unknown) {
    return { ok: false, error: `wasm instantiation failed: ${err instanceof Error ? err.message : String(err)}` };
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
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
