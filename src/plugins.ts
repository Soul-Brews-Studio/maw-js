/**
 * Plugin System v2 — 4-phase lifecycle hooks + scoped unload + hot-reload.
 *
 * Inspired by cmmakerclub/MQTT-Connector (Nat's Arduino lib, 2016):
 *   - Hook signature IS the permission (pointer=modify, value=read, bool*=cancel)
 *   - Lifecycle sequence: GATE → FILTER → HANDLE → LATE
 *
 * Plugin authors write:
 *   export default function(hooks) {
 *     hooks.gate("PreToolUse", (event) => event.oracle !== "blocked"); // cancel
 *     hooks.filter("*", (event) => ({ ...event, message: redact(event.message) })); // modify
 *     hooks.on("SessionStart", (event) => console.log(event)); // observe
 *     hooks.late("*", (event) => auditLog(event)); // guaranteed cleanup
 *   }
 *
 * Hot-reload: watchUserPlugins() + reloadUserPlugins() let user plugins be
 * re-loaded on file change without touching builtin plugins or restarting
 * the server. Every hook entry is tagged with its source scope so a reload
 * only drops user-scoped registrations — builtin plugins stay live.
 */

import type { FeedEvent, FeedEventType } from "./lib/feed";

type Gate = (event: Readonly<FeedEvent>) => boolean;
type Filter = (event: FeedEvent) => FeedEvent;
type Handler = (event: Readonly<FeedEvent>) => void | Promise<void>;
type Late = (event: Readonly<FeedEvent>) => void;
export type MawPlugin = (hooks: MawHooks) => void | (() => void);
export type PluginScope = "builtin" | "user";

interface Scoped<T> { fn: T; scope: PluginScope; }

export interface MawHooks {
  /** Phase 0: GATE — return false to cancel the entire pipeline */
  gate(event: FeedEventType | "*", fn: Gate): void;
  /** Phase 1: FILTER — modify event before handlers see it (Drupal hook_alter) */
  filter(event: FeedEventType | "*", fn: Filter): void;
  /** Phase 2: HANDLE — observe/react to event (read-only) */
  on(event: FeedEventType | "*", fn: Handler): void;
  /** Phase 3: LATE — guaranteed cleanup, runs even if handlers error */
  late(event: FeedEventType | "*", fn: Late): void;
}

export interface PluginInfo {
  name: string;
  type: "ts" | "js" | "wasm-shared" | "wasm-wasi" | "unknown";
  source: PluginScope;
  loadedAt: string;
  events: number;
  errors: number;
  lastEvent?: string;
  lastError?: string;
}

export class PluginSystem {
  private gates = new Map<string, Scoped<Gate>[]>();
  private filters = new Map<string, Scoped<Filter>[]>();
  private handlers = new Map<string, Scoped<Handler>[]>();
  private lates = new Map<string, Scoped<Late>[]>();
  private teardowns: Scoped<() => void>[] = [];
  private _plugins: PluginInfo[] = [];
  private _totalEvents = 0;
  private _totalErrors = 0;
  private _gated = 0;
  private _startedAt = new Date().toISOString();
  private _currentScope: PluginScope = "user";
  private _reloads = 0;
  private _lastReloadAt?: string;

  private _addTo<T>(map: Map<string, Scoped<T>[]>, event: string, fn: T) {
    const entry: Scoped<T> = { fn, scope: this._currentScope };
    const list = map.get(event);
    if (list) list.push(entry);
    else map.set(event, [entry]);
  }

  readonly hooks: MawHooks = {
    gate: (event, fn) => this._addTo(this.gates, event, fn),
    filter: (event, fn) => this._addTo(this.filters, event, fn),
    on: (event, fn) => this._addTo(this.handlers, event, fn),
    late: (event, fn) => this._addTo(this.lates, event, fn),
  };

  /**
   * Emit event through the 4-phase pipeline.
   * Returns true if event was processed, false if gated (cancelled).
   */
  async emit(event: FeedEvent): Promise<boolean> {
    this._totalEvents++;

    // Phase 0: GATE — any gate returning false cancels the pipeline
    const frozen = Object.freeze({ ...event });
    for (const { fn } of this.gates.get(event.event) ?? []) {
      try { if (fn(frozen) === false) { this._gated++; return false; } } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:gate] ${event.event}:`, (err as Error).message);
      }
    }
    for (const { fn } of this.gates.get("*") ?? []) {
      try { if (fn(frozen) === false) { this._gated++; return false; } } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:gate] *:`, (err as Error).message);
      }
    }

    // Phase 1: FILTER — modify event (mutable)
    for (const { fn } of this.filters.get(event.event) ?? []) {
      try { event = fn(event); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:filter] ${event.event}:`, (err as Error).message);
      }
    }
    for (const { fn } of this.filters.get("*") ?? []) {
      try { event = fn(event); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:filter] *:`, (err as Error).message);
      }
    }

    // Phase 2: HANDLE — observe (read-only)
    const readOnly = Object.freeze({ ...event });
    for (const { fn } of this.handlers.get(event.event) ?? []) {
      try { await fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin] ${event.event}:`, (err as Error).message);
      }
    }
    for (const { fn } of this.handlers.get("*") ?? []) {
      try { await fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin] *:`, (err as Error).message);
      }
    }

    // Phase 3: LATE — guaranteed cleanup (runs even if HANDLE threw)
    for (const { fn } of this.lates.get(event.event) ?? []) {
      try { fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:late] ${event.event}:`, (err as Error).message);
      }
    }
    for (const { fn } of this.lates.get("*") ?? []) {
      try { fn(readOnly); } catch (err) {
        this._totalErrors++;
        console.error(`[plugin:late] *:`, (err as Error).message);
      }
    }

    // Update per-plugin stats
    for (const p of this._plugins) {
      p.events = this._totalEvents;
      p.lastEvent = event.event;
    }

    return true;
  }

  /**
   * Invoke a plugin factory and record all its hook registrations + teardown
   * under the given scope. Defaults to "user" so the common (external plugin)
   * path stays one argument; built-in plugins pass "builtin" explicitly.
   */
  load(plugin: MawPlugin, scope: PluginScope = "user") {
    const prev = this._currentScope;
    this._currentScope = scope;
    try {
      const teardown = plugin(this.hooks);
      if (typeof teardown === "function") {
        this.teardowns.push({ fn: teardown, scope });
      }
    } finally {
      this._currentScope = prev;
    }
  }

  register(name: string, type: PluginInfo["type"], source: PluginScope = "user") {
    this._plugins.push({ name, type, source, loadedAt: new Date().toISOString(), events: 0, errors: 0 });
  }

  /**
   * Unload every plugin registered under `scope`: run its teardowns, drop its
   * hook registrations, remove its PluginInfo. Other scopes are untouched.
   *
   * This is the scoped-reset primitive that makes hot-reload safe: user
   * plugins can be dropped and re-imported while builtin plugins stay live.
   */
  unloadScope(scope: PluginScope) {
    // Run teardowns for this scope, keep others
    const keep: Scoped<() => void>[] = [];
    for (const t of this.teardowns) {
      if (t.scope === scope) {
        try { t.fn(); } catch {}
      } else {
        keep.push(t);
      }
    }
    this.teardowns = keep;

    // Strip scoped entries from each hook map
    const clean = <T>(map: Map<string, Scoped<T>[]>) => {
      for (const [key, list] of map) {
        const kept = list.filter((e) => e.scope !== scope);
        if (kept.length === 0) map.delete(key);
        else map.set(key, kept);
      }
    };
    clean(this.gates);
    clean(this.filters);
    clean(this.handlers);
    clean(this.lates);

    // Drop PluginInfo entries for this scope
    this._plugins = this._plugins.filter((p) => p.source !== scope);
  }

  /** Internal: bump the reload counter. Used by reloadUserPlugins(). */
  _markReloaded() {
    this._reloads++;
    this._lastReloadAt = new Date().toISOString();
  }

  stats() {
    const countScoped = <T>(map: Map<string, Scoped<T>[]>) =>
      Object.fromEntries([...map].map(([k, v]) => [k, v.length]));
    return {
      startedAt: this._startedAt,
      plugins: this._plugins,
      totalEvents: this._totalEvents,
      totalErrors: this._totalErrors,
      gated: this._gated,
      reloads: this._reloads,
      lastReloadAt: this._lastReloadAt,
      gates: countScoped(this.gates),
      filters: countScoped(this.filters),
      handlers: countScoped(this.handlers),
      lates: countScoped(this.lates),
    };
  }

  destroy() {
    for (const t of this.teardowns) {
      try { t.fn(); } catch {}
    }
    this.teardowns = [];
  }
}

/**
 * Load a WASM plugin. Contract:
 *   - Module exports `handle(ptr, len)` and `memory`
 *   - We write JSON event to shared memory, call handle()
 *   - OR: module exports `on_event` string array for filtering
 *   - Fallback: if module exports `_start` (WASI), run as subprocess per event
 */
async function loadWasmPlugin(system: PluginSystem, path: string, filename: string, source: PluginScope = "user") {
  const { readFileSync } = require("fs");
  const wasmBytes = readFileSync(path);
  const mod = new WebAssembly.Module(wasmBytes);
  const exports = WebAssembly.Module.exports(mod);
  const exportNames = exports.map((e: { name: string }) => e.name);

  // Check for handle + memory pattern (shared memory plugin)
  if (exportNames.includes("handle") && exportNames.includes("memory")) {
    const instance = new WebAssembly.Instance(mod);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const handle = instance.exports.handle as (ptr: number, len: number) => void;
    const encoder = new TextEncoder();

    system.load((hooks) => {
      hooks.on("*", (event) => {
        const json = encoder.encode(JSON.stringify(event));
        const buf = new Uint8Array(memory.buffer);
        buf.set(json, 0);
        handle(0, json.length);
      });
    }, source);
    system.register(filename, "wasm-shared", source);
    console.log(`[plugin] loaded wasm: ${filename} (shared memory)`);
    return;
  }

  // Check for WASI module (_start export) — pass event as JSON via stdin
  if (exportNames.includes("_start")) {
    const { WASI } = require("wasi");
    system.load((hooks) => {
      hooks.on("*", (event) => {
        try {
          const input = Buffer.from(JSON.stringify(event) + "\n");
          let pos = 0;
          const wasi = new WASI({
            version: "preview1",
            args: [filename, event.event],
            env: {
              MAW_EVENT: event.event,
              MAW_ORACLE: event.oracle,
              MAW_HOST: event.host,
              MAW_MESSAGE: event.message,
              MAW_SESSION: event.sessionId,
              MAW_TIMESTAMP: event.timestamp,
            },
            getStdin: () => {
              const chunk = input.subarray(pos, pos + 4096);
              pos += chunk.length;
              return chunk.length > 0 ? chunk : null;
            },
            sendStdout: (data: Buffer) => process.stdout.write(data),
            sendStderr: (data: Buffer) => process.stderr.write(data),
          });
          const instance = new WebAssembly.Instance(mod, {
            wasi_snapshot_preview1: wasi.wasiImport,
          });
          wasi.start(instance);
        } catch {}
      });
    }, source);
    system.register(filename, "wasm-wasi", source);
    console.log(`[plugin] loaded wasm: ${filename} (WASI)`);
    return;
  }

  // Skip — not a plugin-compatible WASM module (like demo.wasm with just add/mul)
  console.log(`[plugin] skipped wasm: ${filename} (no handle or _start export)`);
}

/**
 * Load plugins from a directory (convention: ~/.oracle/plugins/).
 *
 * Supported formats:
 *   .ts / .js  — TypeScript/JavaScript: export default function(hooks) { ... }
 *   .wasm      — WebAssembly: export handle(ptr, len) + memory, or WASI _start
 *
 * @param cacheBust  If true, append ?t=<timestamp> to the import specifier so
 *                   Bun re-evaluates the module instead of returning a cached
 *                   copy. Used by hot-reload; disabled for initial startup.
 */
export async function loadPlugins(
  system: PluginSystem,
  dir: string,
  source: PluginScope = "user",
  cacheBust = false,
) {
  const { readdirSync } = require("fs");
  const { join } = require("path");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f: string) =>
      f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".wasm")
    );
  } catch {
    return; // dir doesn't exist — no plugins, no error
  }
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
          console.log(`[plugin] loaded: ${file} (${source})`);
        }
      }
    } catch (err) {
      console.error(`[plugin] failed to load ${file}:`, (err as Error).message);
    }
  }
}

/**
 * Reload every user plugin in `dir`: run user teardowns, drop user hook
 * registrations, then re-import every file with cache-busting so edits on
 * disk are picked up. Builtin plugins are left untouched.
 *
 * Safe to call repeatedly. Bumps the reload counter visible via stats().
 */
export async function reloadUserPlugins(system: PluginSystem, dir: string) {
  system.unloadScope("user");
  await loadPlugins(system, dir, "user", true);
  system._markReloaded();
  console.log(`[plugin] reloaded user plugins from ${dir}`);
}

/**
 * Watch a plugins directory for file changes. On any change to a .ts/.js/.wasm
 * file the debounced timer fires `onReload(filename)`. Disable entirely by
 * setting `MAW_HOT_RELOAD=0`.
 *
 * Returns a close function that stops the watcher and cancels any pending
 * debounced reload.
 */
export function watchUserPlugins(
  dir: string,
  onReload: (changedFile: string) => void | Promise<void>,
  debounceMs = 200,
): () => void {
  if (process.env.MAW_HOT_RELOAD === "0") {
    console.log(`[plugin] hot-reload disabled via MAW_HOT_RELOAD=0`);
    return () => {};
  }

  const { watch, existsSync } = require("fs");
  if (!existsSync(dir)) {
    // Nothing to watch yet — user hasn't created ~/.oracle/plugins/.
    return () => {};
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastChanged = "";

  let watcher: { close: () => void };
  try {
    watcher = watch(dir, { persistent: false }, (_eventType: string, filename: string | null) => {
      if (!filename) return;
      if (!(filename.endsWith(".ts") || filename.endsWith(".js") || filename.endsWith(".wasm"))) return;
      lastChanged = filename;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        Promise.resolve(onReload(lastChanged)).catch((err) => {
          console.error(`[plugin:reload] failed for ${lastChanged}:`, (err as Error).message);
        });
      }, debounceMs);
    });
  } catch (err) {
    console.error(`[plugin:watch] cannot watch ${dir}:`, (err as Error).message);
    return () => {};
  }

  console.log(`[plugin] hot-reload watching ${dir}`);
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher.close(); } catch {}
  };
}
