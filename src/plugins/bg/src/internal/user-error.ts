/**
 * UserError — user-facing failure (bad input, missing target, unknown cmd).
 *
 * TEMP: copied verbatim from `maw-js/src/core/util/user-error.ts` per RFC#1
 * §"Error semantics" + lean-core task #6 P3. Will be replaced by an
 * SDK re-export once the public surface lands — see
 * https://github.com/Soul-Brews-Studio/maw-js/issues/844.
 *
 * Why a brand field instead of `instanceof UserError`: class identity
 * breaks across module boundaries in ESM (dynamic import, separate
 * realms). The `isUserError` brand survives.
 *
 * Throw UserError for: missing/invalid args, unknown commands, bad
 *   target resolution. Throw a regular Error for genuinely unexpected
 *   runtime failures so the stack stays visible for debugging.
 */
export class UserError extends Error {
  readonly isUserError = true;
  /** Optional exit code override. Default 1; collisions use 2; tmux-missing 3. */
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "UserError";
    this.exitCode = exitCode;
  }
}

export function isUserError(e: unknown): e is UserError {
  return e instanceof Error && (e as { isUserError?: boolean }).isUserError === true;
}
