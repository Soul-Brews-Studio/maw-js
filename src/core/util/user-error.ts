/**
 * UserError signals a user-facing failure — bad input, missing target,
 * unknown command. The top-level error handler in src/cli.ts catches
 * these and exits 1 WITHOUT letting bun print its default stack trace.
 * For genuinely unexpected runtime failures, throw a regular Error so
 * the stack stays visible for debugging.
 *
 * Convention: throw sites may print richer context (colors, hints,
 * suggestions) before throwing. The top-level catch still prints this
 * message so direct UserError throws never disappear silently.
 *
 * Throw UserError for: missing/invalid args, unknown commands, bad
 *   target resolution, help-path exits.
 * Throw regular Error for: genuinely unexpected runtime failures
 *   where the stack is valuable for debugging.
 *
 * Why a brand field instead of `instanceof UserError`: class identity
 * breaks across module boundaries in ESM (dynamic import, separate
 * realms). The `isUserError` brand survives.
 */
export class UserError extends Error {
  readonly isUserError = true;
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export function isUserError(e: unknown): e is UserError {
  return e instanceof Error && (e as { isUserError?: boolean }).isUserError === true;
}
