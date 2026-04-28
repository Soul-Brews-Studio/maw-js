/**
 * @maw-js/sdk/plugin — plugin-authoring surface.
 *
 * Self-contained declarations — no parent-relative imports, no peer-dep
 * type references. Mirrors src/plugin/types.ts (InvokeContext / InvokeResult),
 * src/core/util/user-error.ts (UserError + isUserError), and
 * src/cli/parse-args.ts (parseFlags) so plugin authors can import without
 * a path or peer-dep dance.
 *
 * See #844 / #848 — shellenv inlined UserError + parseFlags as TEMP for its
 * v0.1.0 tag; once this declaration ships those inlines drop in v0.2.0.
 */

// ─── Plugin invocation types ─────────────────────────────────────────────────

export interface InvokeContext {
  /** Where the plugin is being called from. */
  source: "cli" | "api" | "peer";
  /** CLI args (string[]) or API/peer args (object). */
  args: string[] | Record<string, unknown>;
}

export interface InvokeResult {
  /** True on success, false on error. */
  ok: boolean;
  /** Optional text output returned to the caller. */
  output?: string;
  /** Optional error message when `ok` is false. */
  error?: string;
}

// ─── UserError — user-facing failure with ESM-safe brand ─────────────────────

/**
 * UserError signals a user-facing failure — bad input, missing target,
 * unknown command. The throw site is responsible for printing the
 * user-facing output BEFORE throwing; the top-level catch exits 1
 * cleanly without printing a stack trace.
 *
 * The `isUserError` brand survives ESM module-boundary crossings where
 * `instanceof UserError` would not.
 */
export declare class UserError extends Error {
  readonly isUserError: true;
  constructor(message: string);
}

/** Type guard — true for any error (cross-realm) carrying the UserError brand. */
export declare function isUserError(e: unknown): e is UserError;

// ─── parseFlags — permissive `arg` wrapper ───────────────────────────────────

/**
 * Minimal arg-spec shape — keeps plugin.d.ts self-contained without forcing
 * plugin authors to depend on `arg`'s type package. Plugins that want richer
 * typing can import `arg` directly and pass-through.
 */
export type ParseFlagsHandler<T = unknown> = (
  value: string,
  name: string,
  previousValue?: T,
) => T;

export interface ParseFlagsSpec {
  [key: string]: string | ParseFlagsHandler | [ParseFlagsHandler];
}

export type ParseFlagsResult<T extends ParseFlagsSpec> = { _: string[] } & {
  [K in keyof T]?: T[K] extends ParseFlagsHandler<infer R>
    ? R
    : T[K] extends [ParseFlagsHandler<infer R>]
    ? R[]
    : unknown;
};

/**
 * Parse flags from an args array. Permissive — unknown flags fall through
 * to `result._` rather than throwing. Wraps the `arg` package.
 *
 * @param args  raw process.argv.slice(2) array
 * @param spec  arg spec (e.g. `{ "--verbose": Boolean, "--from": String }`)
 * @param skip  number of leading positional args to skip (default 0) —
 *              e.g. `skip=1` for `bud <name> --from neo` skips `bud`
 */
export declare function parseFlags<T extends ParseFlagsSpec>(
  args: string[],
  spec: T,
  skip?: number,
): ParseFlagsResult<T>;
