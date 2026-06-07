#!/usr/bin/env bun
/**
 * migrate-plugin-json-to-ts.ts — codemod for #2510.
 *
 * Generates plugin.ts files from existing plugin.json manifests while keeping
 * the JSON files intact as fallback.
 *
 * Usage:
 *   bun scripts/migrate-plugin-json-to-ts.ts [--root <path>] [--dry-run]
 *   bun scripts/migrate-plugin-json-to-ts.ts --overwrite [--root <path>]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run") || argv.has("-n");
const overwrite = argv.has("--overwrite") || argv.has("-f");
const rootArgIndex = process.argv.findIndex((arg) => arg === "--root");
const root = rootArgIndex >= 0 && process.argv[rootArgIndex + 1] ? process.argv[rootArgIndex + 1] : process.cwd();

const SKIP_DIRS = new Set([
  ".git",
  ".bun",
  "node_modules",
  "coverage",
  "dist",
  "dist-office",
  "agents",
]);

function collectPluginJson(dir: string, out: string[] = []): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectPluginJson(join(dir, entry.name), out);
      continue;
    }

    if (entry.isFile() && entry.name === "plugin.json") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function formatPluginTs(source: Record<string, unknown>): string {
  const body = JSON.stringify(source, null, 2);
  return [
    `import { definePlugin } from "maw-js/sdk";`,
    "",
    `export default definePlugin(${body} as const);`,
    "",
  ].join("\n");
}

function loadPluginJson(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`plugin.json is not an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

const pluginJsonPaths = collectPluginJson(root);

let skipped = 0;
let wrote = 0;
let failed = 0;

for (const pluginJsonPath of pluginJsonPaths) {
  const pluginDir = dirname(pluginJsonPath);
  const pluginTsPath = join(pluginDir, "plugin.ts");
  const hasTs = existsSync(pluginTsPath);

  if (hasTs && !overwrite) {
    skipped += 1;
    continue;
  }

  try {
    const manifest = loadPluginJson(pluginJsonPath);

    const pluginTsDir = pluginDir;
    if (!existsSync(pluginTsDir)) {
      mkdirSync(pluginTsDir, { recursive: true });
    }

    const output = formatPluginTs(manifest);
    if (dryRun) {
      console.log(`[dry-run] ${relative(root, pluginTsPath)} (${hasTs ? "overwrite" : "create"})`);
      continue;
    }

    writeFileSync(pluginTsPath, output, "utf8");
    wrote += 1;
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ failed: ${relative(root, pluginJsonPath)} -> ${message}`);
  }
}

const label = `${wrote} created/updated, ${skipped} skipped`;
console.log(`plugin.json→plugin.ts migration: ${label}, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
