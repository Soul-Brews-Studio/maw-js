/**
 * Plugin package types — shared contract between manifest, registry, api-router, and example-plugin.
 *
 * A plugin package is a directory containing:
 *   plugin.json  — this manifest
 *   <name>.wasm  — compiled WASM module (sandboxed, portable)
 *   OR index.ts  — TypeScript entry (full access, Bun only)
 *
 * Both types share the same manifest shape. The difference:
 *   wasm: string  → sandboxed WASM plugin (host functions only)
 *   entry: string → TS plugin (full maw-js internals access)
 */

export interface PluginManifest {
  name: string;           // unique id, slug-safe /^[a-z0-9-]+$/
  version: string;        // semver e.g. "1.0.0"
  wasm?: string;          // relative path to .wasm (WASM plugin)
  entry?: string;         // relative path to .ts/.js (TS plugin)
  sdk: string;            // semver range e.g. "^1.0.0"
  cli?: { command: string; help?: string; };
  api?: { path: string; methods: ("GET" | "POST")[]; };
  description?: string;
  author?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;            // absolute dir containing plugin.json
  wasmPath: string;       // resolved path to .wasm (empty for TS plugins)
  entryPath?: string;     // resolved path to .ts/.js (TS plugins only)
  kind: "wasm" | "ts";    // plugin type
}

export interface InvokeContext {
  source: "cli" | "api" | "peer";
  args: string[] | Record<string, unknown>;
}

export interface InvokeResult {
  ok: boolean;
  output?: string;
  error?: string;
}
