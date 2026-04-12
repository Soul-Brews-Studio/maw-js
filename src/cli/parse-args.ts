/**
 * Shared CLI argument parsing via `arg`.
 *
 * Each command defines its flag spec. `parseFlags` wraps arg() with:
 * - permissive mode (unknown flags don't throw — they go to argv._)
 * - sliced argv (strips "maw" + command name)
 *
 * Usage:
 *   const flags = parseFlags(args, { "--verbose": Boolean, "-v": "--verbose" }, 2);
 *   flags["--verbose"]  // boolean | undefined
 *   flags._             // positional args
 */

import arg from "arg";

/**
 * Parse flags from args array.
 * @param args - raw process.argv.slice(2) array
 * @param spec - arg spec (e.g. { "--verbose": Boolean, "--from": String })
 * @param skip - number of leading positional args to skip (default 0)
 *               e.g. skip=1 for "bud <name> --from neo" skips "bud"
 */
export function parseFlags<T extends arg.Spec>(
  args: string[],
  spec: T,
  skip = 0,
): arg.Result<T> {
  return arg(spec, { argv: args.slice(skip), permissive: true });
}
