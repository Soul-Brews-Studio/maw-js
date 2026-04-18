/**
 * @maw-js/sdk/plugin — plugin-authoring types.
 *
 * Self-contained declarations. Mirrors src/plugin/types.ts InvokeContext +
 * InvokeResult so plugin authors can import without a path dependency.
 */

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
