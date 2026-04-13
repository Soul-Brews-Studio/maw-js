/**
 * Plugin package types — shared contract between manifest, registry, api-router, and example-plugin.
 *
 * A plugin package is a directory containing:
 *   plugin.json  — this manifest
 *   <name>.wasm  — the compiled WASM module
 */

export interface PluginManifest {
  name: string;           // unique id, slug-safe /^[a-z0-9-]+$/
  version: string;        // semver e.g. "1.0.0"
  wasm: string;           // relative path to .wasm from manifest dir
  sdk: string;            // semver range e.g. "^1.0.0"
  cli?: { command: string; help?: string; };
  api?: { path: string; methods: ("GET" | "POST")[]; };
  description?: string;
  author?: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;            // absolute dir containing plugin.json
  wasmPath: string;       // resolved absolute path to .wasm
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
