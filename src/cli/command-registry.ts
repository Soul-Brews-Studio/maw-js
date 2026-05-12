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

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { loadWasmCommand } from "./command-registry-wasm";
import { registerCommand } from "./command-registry-match";

export type { CommandDescriptor } from "./command-registry-types";
export { registerCommand, matchCommand, listCommands } from "./command-registry-match";
export { executeCommand } from "./command-registry-execute";
export { loadWasmCommand } from "./command-registry-wasm";

/** Scan a directory for command plugins */
export async function scanCommands(dir: string, scope: "builtin" | "user"): Promise<number> {
  if (!existsSync(dir)) return 0;
  const disabled = loadConfig().disabledPlugins ?? [];
  let count = 0;
  for (const file of readdirSync(dir).filter(f => /\.(ts|js|wasm)$/.test(f))) {
    try {
      const path = join(dir, file);
      if (file.endsWith(".wasm")) {
        await loadWasmCommand(path, file, scope, disabled);
        count++;
      } else {
        const mod = await import(path);
        if (mod.command?.name) {
          const cmdName = Array.isArray(mod.command.name) ? mod.command.name[0] : mod.command.name;
          if (disabled.includes(cmdName)) continue;
          registerCommand(mod.command, path, scope);
          count++;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message?.slice(0, 80) : String(err).slice(0, 80);
      console.error(`[commands] failed to load ${file}: ${msg}`);
    }
  }
  return count;
}
