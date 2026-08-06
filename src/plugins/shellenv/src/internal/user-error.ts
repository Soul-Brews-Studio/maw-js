// TEMP: inlined from maw-js core. Migrate to @maw-js/sdk import once SDK exposes (tracked in Soul-Brews-Studio/maw-js#844).
/**
 * UserError signals a user-facing failure — bad input, missing target.
 * The plugin host catches these and exits 1 without printing a stack.
 *
 * Brand field instead of `instanceof`: class identity breaks across
 * module boundaries in ESM (dynamic import, separate realms). The
 * `isUserError` brand survives.
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
