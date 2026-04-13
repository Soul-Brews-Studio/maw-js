/**
 * Command Plugin Registry (beta) — pluggable CLI commands.
 *
 * Drop a .ts/.js file in ~/.oracle/commands/ with:
 *   export const command = { name: "hello", description: "Say hello" };
 *   export default async function(args, flags) { ... }
 *
 * Or drop a .wasm file that exports handle(ptr, len) + memory.
 * Args are passed as JSON in shared memory; output read back from memory.
 *
 * Supports subcommands: name: "fleet doctor" or ["fleet doctor", "fleet dr"]
 * Longest prefix match wins. Core routes always take priority.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseFlags } from "./parse-args";

export interface CommandDescriptor {
  name: string | string[];
  description: string;
  usage?: string;
  flags?: Record<string, any>;
  /** Resolved at registration */
  patterns?: string[][];
  path?: string;
  scope?: "builtin" | "user";
}

const commands = new Map<string, { desc: CommandDescriptor; path: string }>();

/** Cached WASM command instances, keyed by file path */
const wasmInstances = new Map<string, {
  handle: (ptr: number, len: number) => number;
  memory: WebAssembly.Memory;
  instance: WebAssembly.Instance;
}>();

/** Register a command from a descriptor + file path */
export function registerCommand(desc: CommandDescriptor, path: string, scope: "builtin" | "user") {
  const names = Array.isArray(desc.name) ? desc.name : [desc.name];
  for (const n of names) {
    const key = n.toLowerCase().trim();
    if (commands.has(key)) {
      console.log(`[commands] overriding "${key}" (was: ${commands.get(key)!.desc.scope}, now: ${scope})`);
    }
    commands.set(key, { desc: { ...desc, scope, path }, path });
  }
}

/** Match args against registered commands. Longest prefix wins. */
export function matchCommand(args: string[]): { desc: CommandDescriptor; remaining: string[]; key: string } | null {
  let best: { desc: CommandDescriptor; remaining: string[]; key: string; len: number } | null = null;

  for (const [key, entry] of commands) {
    const parts = key.split(/\s+/);
    // Check if args start with this command's parts
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      if (!args[i] || args[i].toLowerCase() !== parts[i]) { match = false; break; }
    }
    if (match && parts.length > (best?.len ?? 0)) {
      best = { desc: entry.desc, remaining: args.slice(parts.length), key, len: parts.length };
    }
  }

  return best;
}

/**
 * Load a WASM command plugin. Expects exports: handle(ptr, len) + memory.
 * Optionally exports command_name/command_desc globals for metadata.
 */
async function loadWasmCommand(path: string, filename: string, scope: "builtin" | "user"): Promise<void> {
  const wasmBytes = readFileSync(path);
  const mod = new WebAssembly.Module(wasmBytes);
  const exports = WebAssembly.Module.exports(mod);
  const exportNames = exports.map((e: { name: string }) => e.name);

  // Must have handle + memory
  if (!exportNames.includes("handle") || !exportNames.includes("memory")) {
    console.log(`[commands] skipped wasm: ${filename} (no handle+memory exports)`);
    return;
  }

  const instance = new WebAssembly.Instance(mod);
  const handle = instance.exports.handle as (ptr: number, len: number) => number;
  const memory = instance.exports.memory as WebAssembly.Memory;

  // Read command name from exports or derive from filename
  const name = (instance.exports.command_name as WebAssembly.Global)?.value
    || filename.replace(/\.wasm$/, "");
  const description = (instance.exports.command_desc as WebAssembly.Global)?.value
    || `WASM command: ${filename}`;

  registerCommand(
    { name, description },
    path,
    scope,
  );

  // Store the instance for execution
  wasmInstances.set(path, { handle, memory, instance });
  console.log(`[commands] loaded wasm: ${filename}`);
}

/** Execute a matched command — lazy import + parseFlags + call handler */
export async function executeCommand(desc: CommandDescriptor, remaining: string[]): Promise<void> {
  if (desc.path?.endsWith(".wasm")) {
    const wasm = wasmInstances.get(desc.path!);
    if (!wasm) { console.error(`[commands] WASM instance not found: ${desc.path}`); return; }
    // Write args as JSON to shared memory
    const json = JSON.stringify(remaining);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(json);
    const view = new Uint8Array(wasm.memory.buffer);
    view.set(bytes, 0);
    // Call handle(ptr=0, len=bytes.length)
    const resultPtr = wasm.handle(0, bytes.length);
    // Read result from memory if returned
    if (resultPtr > 0) {
      const decoder = new TextDecoder();
      // Read until null terminator or reasonable limit
      let end = resultPtr;
      while (end < view.length && view[end] !== 0) end++;
      const result = decoder.decode(view.slice(resultPtr, end));
      if (result) console.log(result);
    }
    return;
  }
  const mod = await import(desc.path!);
  const handler = mod.default || mod.handler;
  if (!handler) { console.error(`[commands] ${desc.name}: no default export or handler`); return; }
  const flags = desc.flags ? parseFlags(["_", ...remaining], desc.flags, 1) : { _: remaining };
  await handler(flags._, flags);
}

/** Scan a directory for command plugins */
export async function scanCommands(dir: string, scope: "builtin" | "user"): Promise<number> {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of readdirSync(dir).filter(f => /\.(ts|js|wasm)$/.test(f))) {
    try {
      const path = join(dir, file);
      if (file.endsWith(".wasm")) {
        await loadWasmCommand(path, file, scope);
        count++;
      } else {
        const mod = await import(path);
        if (mod.command?.name) {
          registerCommand(mod.command, path, scope);
          count++;
        }
      }
    } catch (err: any) {
      console.error(`[commands] failed to load ${file}: ${err.message?.slice(0, 80)}`);
    }
  }
  return count;
}

/** List all registered commands (for --help and completions) */
export function listCommands(): CommandDescriptor[] {
  const seen = new Set<string>();
  const result: CommandDescriptor[] = [];
  for (const [, entry] of commands) {
    const key = entry.path;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry.desc);
  }
  return result;
}
