/**
 * Command Plugin Registry (beta) — pluggable CLI commands.
 *
 * Drop a .ts/.js file in ~/.oracle/commands/ with:
 *   export const command = { name: "hello", description: "Say hello" };
 *   export default async function(args, flags) { ... }
 *
 * Supports subcommands: name: "fleet doctor" or ["fleet doctor", "fleet dr"]
 * Longest prefix match wins. Core routes always take priority.
 */

import { readdirSync, existsSync } from "fs";
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

/** Execute a matched command — lazy import + parseFlags + call handler */
export async function executeCommand(desc: CommandDescriptor, remaining: string[]): Promise<void> {
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
  for (const file of readdirSync(dir).filter(f => /\.(ts|js)$/.test(f))) {
    try {
      const path = join(dir, file);
      const mod = await import(path);
      if (mod.command?.name) {
        registerCommand(mod.command, path, scope);
        count++;
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
