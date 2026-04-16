/**
 * UserError signals a user-facing failure — bad input, missing target,
 * unknown command. The top-level error handler in src/cli.ts catches
 * these and exits 1 WITHOUT letting bun print its default stack trace.
 * For genuinely unexpected runtime failures, throw a regular Error so
 * the stack stays visible for debugging.
 *
 * Convention: the throw site is responsible for printing the
 * user-facing output (primary error line + any "did you mean" hints)
 * BEFORE throwing. The top-level catch just exits cleanly. This lets
 * sites compose multi-line output (colors, hints, suggestions) without
 * the error class having to carry that structure.
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
