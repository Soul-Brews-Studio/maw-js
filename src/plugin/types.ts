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

/**
 * Plugin compile target. Phase A ships `"js"` only. `"wasm"` is a reserved
 * slot for Phase C — parser validates+rejects today so the enum shape can
 * extend without a manifest migration when WASM compilation lands.
 */
export type PluginTarget = "js" | "wasm";

export type PluginTier = "core" | "standard" | "extra";

/**
 * Built-plugin artifact descriptor. Present on compiled plugins written
 * by `maw plugin build`. `sha256: null` means "unbuilt" — the loader
 * refuses such plugins with a "run `maw plugin build`" message.
 */
export interface PluginArtifact {
  path: string;             // relative path to built bundle (e.g. "dist/index.js")
  sha256: string | null;    // sha256 of the bundle, or null if unbuilt
}

export interface PluginManifest {
  name: string;           // unique id, slug-safe /^[a-z0-9-]+$/
  version: string;        // semver e.g. "1.0.0"
  weight?: number;        // execution order: lower = first (default 50, like Drupal)
  tier?: PluginTier;      // membership contract: "core" | "standard" | "extra" (#675)
  wasm?: string;          // relative path to .wasm (WASM plugin)
  entry?: string;         // relative path to .ts/.js (TS plugin)
  sdk: string;            // semver range e.g. "^1.0.0"
  target?: PluginTarget;  // compile target (Phase A: "js" only)
  capabilities?: string[];// declared capability strings "namespace:verb" (advisory in Phase A)
  artifact?: PluginArtifact; // built-plugin artifact descriptor
  cli?: {
    command: string;
    aliases?: string[];                    // alternate command names
    help?: string;
    flags?: Record<string, string>;        // flag name → "boolean"|"string"|"number"
  };
  api?: { path: string; methods: ("GET" | "POST")[]; };
  description?: string;
  author?: string;
  hooks?: {
    gate?: string[];    // event names to gate
    filter?: string[];  // event names to filter
    on?: string[];      // event names to handle
    late?: string[];    // event names for cleanup
  };
  cron?: {
    schedule: string;   // cron expression
    handler?: string;   // export name (default: "onTick")
  };
  module?: {
    exports: string[];  // named exports other plugins can import
    path: string;       // relative path to module file
  };
  transport?: {
    peer?: boolean;     // enable maw hey plugin:<name>
  };
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;            // absolute dir containing plugin.json
  wasmPath: string;       // resolved path to .wasm (empty for TS plugins)
  entryPath?: string;     // resolved path to .ts/.js (TS plugins only)
  kind: "wasm" | "ts";    // plugin type
  disabled?: boolean;     // true if plugin is in disabledPlugins config list
}

export interface InvokeContext {
  source: "cli" | "api" | "peer";
  args: string[] | Record<string, unknown>;
  /**
   * Optional output writer injected by the invoker based on ctx.source.
   * CLI source → streams to process.stdout (real-time terminal output).
   * API/peer source → undefined; plugin falls back to logs[] capture.
   * Plugins use: `ctx.writer?.(...args) ?? logs.push(args.join(" "))`
   */
  writer?: (...args: unknown[]) => void;
}

export interface InvokeResult {
  ok: boolean;
  output?: string;
  error?: string;
  /**
   * Non-zero exit code for `ok: false` results. When unset, the CLI
   * defaults to exit 1 on failure. Plugins use this to distinguish
   * failure modes for scripts (e.g. handshake vs DNS vs refused).
   */
  exitCode?: number;
}
