import { isUserError } from "../core/util/user-error";
import { AmbiguousMatchError } from "../core/runtime/find-window";
import { renderAmbiguousMatch } from "../core/util/render-ambiguous";

/**
 * Top-level error handler for `main()`. Always exits — never returns.
 *
 * - UserError: print its message without a bun stack trace, then exit 1.
 *   Some call sites throw UserError directly; keeping it silent hides the
 *   actionable reason (for example wake concurrency refusals).
 * - AmbiguousMatchError: escapes from findWindow via resolver chains
 *   (cmdSend, cmdPeek, talk-to, view, etc.). Render as actionable CLI
 *   output instead of a minified stack trace.
 * - Anything else: print the error normally and exit 1.
 */
export function handleTopLevelError(e: unknown, args: string[]): never {
  if (isUserError(e)) {
    if (e.message) process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  if (e instanceof AmbiguousMatchError) {
    console.error(renderAmbiguousMatch(e, args));
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
}
