/**
 * PluginSystem — 4-phase event pipeline (GATE → FILTER → HANDLE → LATE).
 * Inspired by cmmakerclub/MQTT-Connector (Nat's Arduino lib, 2016).
 */

import type { FeedEvent } from "../lib/feed";
import type { Gate, Filter, Handler, Late, MawPlugin, MawHooks, PluginScope, PluginInfo, Scoped } from "./00_types";

export interface PluginSystemOptions {
  shouldSkipHandler?: (eventName: string, pluginName: string | undefined) => boolean;
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
  private _currentPluginName?: string;
  private _reloads = 0;
  private _lastReloadAt?: string;

  constructor(private readonly opts: PluginSystemOptions = {}) {}

  withPluginContext<T>(name: string | undefined, scope: PluginScope, fn: () => T): T {
    const prevScope = this._currentScope;
    const prevName = this._currentPluginName;
    this._currentScope = scope;
    this._currentPluginName = name;
    try {
      return fn();
    } finally {
      this._currentScope = prevScope;
      this._currentPluginName = prevName;
    }
  }

  private _addTo<T>(map: Map<string, Scoped<T>[]>, event: string, fn: T) {
    const entry: Scoped<T> = { fn, scope: this._currentScope, name: this._currentPluginName };
    const list = map.get(event);
    if (list) list.push(entry);
    else map.set(event, [entry]);
  }

  private _recordError(name: string | undefined, err: Error) {
    this._totalErrors++;
    if (!name) return;
    const info = this._plugins.find((p) => p.name === name);
    if (info) { info.errors++; info.lastError = err.message; }
  }

  readonly hooks: MawHooks = {
    gate: (event, fn) => this._addTo(this.gates, event, fn),
    filter: (event, fn) => this._addTo(this.filters, event, fn),
    on: (event, fn) => this._addTo(this.handlers, event, fn),
    late: (event, fn) => this._addTo(this.lates, event, fn),
  };

  async emit(event: FeedEvent): Promise<boolean> {
    this._totalEvents++;
    const frozen = Object.freeze({ ...event });

    // Phase 0: GATE
    for (const { fn, name } of [...(this.gates.get(event.event) ?? []), ...(this.gates.get("*") ?? [])]) {
      try { if (fn(frozen) === false) { this._gated++; return false; } }
      catch (err) { console.error(`[plugin:gate] ${event.event}:`, (err as Error).message); this._recordError(name, err as Error); }
    }

    // Phase 1: FILTER
    // Policy: on throw, continue the chain with the previous event (don't bail on one bad filter).
    // `event = fn(event)` only reassigns on successful return, so a throw leaves `event` unmodified —
    // we make that explicit here by attributing the error and moving on. Alternative would be to throw
    // and stop the chain; chosen continuation for resilience (one misbehaving filter shouldn't blind
    // downstream handlers to all events).
    for (const { fn, name } of [...(this.filters.get(event.event) ?? []), ...(this.filters.get("*") ?? [])]) {
      try { event = fn(event); }
      catch (err) { console.error(`[plugin:filter] ${event.event}:`, (err as Error).message); this._recordError(name, err as Error); }
    }

    // Phase 2: HANDLE
    const readOnly = Object.freeze({ ...event });
    for (const { fn, name } of [...(this.handlers.get(event.event) ?? []), ...(this.handlers.get("*") ?? [])]) {
      if (this.opts.shouldSkipHandler?.(event.event, name)) continue;
      try { await fn(readOnly); }
      catch (err) { console.error(`[plugin] ${event.event}:`, (err as Error).message); this._recordError(name, err as Error); }
    }

    // Phase 3: LATE
    for (const { fn, name } of [...(this.lates.get(event.event) ?? []), ...(this.lates.get("*") ?? [])]) {
      try { fn(readOnly); }
      catch (err) { console.error(`[plugin:late] ${event.event}:`, (err as Error).message); this._recordError(name, err as Error); }
    }

    for (const p of this._plugins) { p.events = this._totalEvents; p.lastEvent = event.event; }
    return true;
  }

  load(plugin: MawPlugin, scope: PluginScope = "user", name?: string) {
    return this.withPluginContext(name, scope, () => {
      const teardown = plugin(this.hooks);
      if (typeof teardown === "function") this.teardowns.push({ fn: teardown, scope });
    });
  }

  register(name: string, type: PluginInfo["type"], source: PluginScope = "user") {
    this._plugins.push({ name, type, source, loadedAt: new Date().toISOString(), events: 0, errors: 0 });
  }

  unloadScope(scope: PluginScope) {
    const keep: Scoped<() => void>[] = [];
    for (const t of this.teardowns) {
      if (t.scope === scope) { try { t.fn(); } catch {} } else keep.push(t);
    }
    this.teardowns = keep;

    const clean = <T>(map: Map<string, Scoped<T>[]>) => {
      for (const [key, list] of map) {
        const kept = list.filter(e => e.scope !== scope);
        if (kept.length === 0) map.delete(key); else map.set(key, kept);
      }
    };
    clean(this.gates); clean(this.filters); clean(this.handlers); clean(this.lates);
    this._plugins = this._plugins.filter(p => p.source !== scope);
  }

  _markReloaded() { this._reloads++; this._lastReloadAt = new Date().toISOString(); }

  stats() {
    const count = <T>(map: Map<string, Scoped<T>[]>) =>
      Object.fromEntries([...map].map(([k, v]) => [k, v.length]));
    return {
      startedAt: this._startedAt, plugins: this._plugins,
      totalEvents: this._totalEvents, totalErrors: this._totalErrors, gated: this._gated,
      reloads: this._reloads, lastReloadAt: this._lastReloadAt,
      gates: count(this.gates), filters: count(this.filters),
      handlers: count(this.handlers), lates: count(this.lates),
    };
  }

  destroy() {
    for (const t of this.teardowns) { try { t.fn(); } catch {} }
    this.teardowns = [];
  }
}
