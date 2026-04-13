/**
 * PluginSystem — 4-phase event pipeline (GATE → FILTER → HANDLE → LATE).
 * Inspired by cmmakerclub/MQTT-Connector (Nat's Arduino lib, 2016).
 */

import type { FeedEvent } from "../lib/feed";
import type { Gate, Filter, Handler, Late, MawPlugin, MawHooks, PluginScope, PluginInfo, Scoped } from "./types";

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

  async emit(event: FeedEvent): Promise<boolean> {
    this._totalEvents++;
    const frozen = Object.freeze({ ...event });

    // Phase 0: GATE
    for (const { fn } of [...(this.gates.get(event.event) ?? []), ...(this.gates.get("*") ?? [])]) {
      try { if (fn(frozen) === false) { this._gated++; return false; } }
      catch (err) { this._totalErrors++; console.error(`[plugin:gate] ${event.event}:`, (err as Error).message); }
    }

    // Phase 1: FILTER
    for (const { fn } of [...(this.filters.get(event.event) ?? []), ...(this.filters.get("*") ?? [])]) {
      try { event = fn(event); }
      catch (err) { this._totalErrors++; console.error(`[plugin:filter] ${event.event}:`, (err as Error).message); }
    }

    // Phase 2: HANDLE
    const readOnly = Object.freeze({ ...event });
    for (const { fn } of [...(this.handlers.get(event.event) ?? []), ...(this.handlers.get("*") ?? [])]) {
      try { await fn(readOnly); }
      catch (err) { this._totalErrors++; console.error(`[plugin] ${event.event}:`, (err as Error).message); }
    }

    // Phase 3: LATE
    for (const { fn } of [...(this.lates.get(event.event) ?? []), ...(this.lates.get("*") ?? [])]) {
      try { fn(readOnly); }
      catch (err) { this._totalErrors++; console.error(`[plugin:late] ${event.event}:`, (err as Error).message); }
    }

    for (const p of this._plugins) { p.events = this._totalEvents; p.lastEvent = event.event; }
    return true;
  }

  load(plugin: MawPlugin, scope: PluginScope = "user") {
    const prev = this._currentScope;
    this._currentScope = scope;
    try {
      const teardown = plugin(this.hooks);
      if (typeof teardown === "function") this.teardowns.push({ fn: teardown, scope });
    } finally { this._currentScope = prev; }
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
