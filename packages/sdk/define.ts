import { PluginEventMap } from "./events";

export interface PluginManifestInput {
  /** Plugin name (must match plugin.json name). */
  name: string;
  /** Optional plugin hooks, currently used for event-handler derivation. */
  hooks?: {
    on?: readonly string[];
    [key: string]: unknown;
  };
  /** Exports made available for hook/module interop. */
  module: {
    exports: readonly string[];
    path: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Convert snake/hyphen separated identifiers to PascalCase fragments. */
type PascalFromSnake<T extends string> = T extends `${infer Head}_${infer Rest}`
  ? `${Capitalize<Lowercase<Head>>}${PascalFromSnake<Rest>}`
  : T extends `${infer Head}-${infer Rest}`
    ? `${Capitalize<Lowercase<Head>>}${PascalFromSnake<Rest>}`
    : Capitalize<Lowercase<T>>;

/** Event name → handler function name. */
export type EventToHandlerName<E extends string> =
  E extends `${infer Scope}:${infer Action}`
    ? `on${Capitalize<Lowercase<Scope>>}${PascalFromSnake<Action>}`
    : `on${Capitalize<Lowercase<E>>}`;

/** Derive required handler signatures from a literal event name list. */
export type HandlersFor<Events extends readonly string[]> = {
  [Event in Events[number] as EventToHandlerName<Event>]:
    Event extends keyof PluginEventMap
      ? (event: PluginEventMap[Event]) => void | Promise<void>
      : (event: unknown) => void | Promise<void>;
};

/** Extract hook event names as a tuple-like union helper. */
type ManifestHookEvents<T extends PluginManifestInput> =
  T extends { hooks: { on: infer HookEvents } }
    ? HookEvents extends readonly string[]
      ? HookEvents
      : []
    : [];

/** Ensure module exports includes all generated handler names. */
export type ValidateExports<T extends PluginManifestInput> =
  keyof HandlersFor<ManifestHookEvents<T>> extends T["module"]["exports"][number]
    ? T
    : never;

/**
 * definePlugin return type exposes `implement()` with strongly typed handlers.
 */
export type DefinedPlugin<T extends PluginManifestInput> = ValidateExports<T> & {
  implement(handlers: HandlersFor<ManifestHookEvents<T>>): ValidateExports<T> & HandlersFor<ManifestHookEvents<T>>;
};

/**
 * Typed identity helper for plugin declarations.
 *
 * - Infers handler names and payload types from `hooks.on`.
 * - Validates required handler exports are present in `module.exports`.
 */
export function definePlugin<const T extends PluginManifestInput>(manifest: ValidateExports<T>): DefinedPlugin<T> {
  return {
    ...manifest,
    implement(handlers) {
      return {
        ...manifest,
        ...handlers,
      };
    },
  } as DefinedPlugin<T>;
}
