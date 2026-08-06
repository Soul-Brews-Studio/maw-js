// TEMP: inlined from maw-js core. Migrate to @maw-js/sdk import once SDK exposes (tracked in Soul-Brews-Studio/maw-js#844).
/**
 * Minimal flag parser — boolean flags + aliases, positionals into `_`.
 *
 * Spec format mirrors `arg` package:
 *   { "--help": Boolean, "-h": "--help" }
 *
 * For shellenv we only need boolean `--help`/`-h` plus a positional
 * shell name; this avoids pulling in the `arg` dependency for ~15 LOC
 * of work.
 */
export type FlagSpec = Record<string, BooleanConstructor | string>;
export type FlagResult<T extends FlagSpec> = {
  [K in keyof T as T[K] extends BooleanConstructor ? K : never]?: boolean;
} & { _: string[] };

export function parseFlags<T extends FlagSpec>(
  args: string[],
  spec: T,
  skip = 0,
): FlagResult<T> {
  const aliases: Record<string, string> = {};
  const booleans = new Set<string>();
  for (const [k, v] of Object.entries(spec)) {
    if (typeof v === "string") aliases[k] = v;
    else if (v === Boolean) booleans.add(k);
  }
  const out: Record<string, unknown> = { _: [] as string[] };
  for (const tok of args.slice(skip)) {
    const canonical = aliases[tok] ?? tok;
    if (booleans.has(canonical)) {
      out[canonical] = true;
    } else if (tok.startsWith("-")) {
      // Unknown flag — permissive: treat as boolean true on the canonical key
      out[canonical] = true;
    } else {
      (out._ as string[]).push(tok);
    }
  }
  return out as FlagResult<T>;
}
