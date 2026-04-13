/**
 * Plugin system types — shared across system, loader, hooks, watcher.
 */

import type { FeedEvent, FeedEventType } from "../lib/feed";

export type Gate = (event: Readonly<FeedEvent>) => boolean;
export type Filter = (event: FeedEvent) => FeedEvent;
export type Handler = (event: Readonly<FeedEvent>) => void | Promise<void>;
export type Late = (event: Readonly<FeedEvent>) => void;
export type MawPlugin = (hooks: MawHooks) => void | (() => void);
export type PluginScope = "builtin" | "user";

export interface Scoped<T> { fn: T; scope: PluginScope; }

export interface MawHooks {
  gate(event: FeedEventType | "*", fn: Gate): void;
  filter(event: FeedEventType | "*", fn: Filter): void;
  on(event: FeedEventType | "*", fn: Handler): void;
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
