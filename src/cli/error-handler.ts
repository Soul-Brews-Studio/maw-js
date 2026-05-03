import { isUserError } from "../core/util/user-error";
import { AmbiguousMatchError } from "../core/runtime/find-window";
import { renderAmbiguousMatch } from "../core/util/render-ambiguous";

/**
 * Top-level error handler for `main()`. Always exits — never returns.
 *
 * - UserError: output already printed at throw site, exit 1 silently
 *   (no bun stack trace).
 * - AmbiguousMatchError: escapes from findWindow via resolver chains
 *   (cmdSend, cmdPeek, talk-to, view, etc.). Render as actionable CLI
 *   output instead of a minified stack trace.
 * - Anything else: print the error normally and exit 1.
 */
export function handleTopLevelError(e: unknown, args: string[]): never {
  if (isUserError(e)) {
    process.exit(1);
  }
  if (e instanceof AmbiguousMatchError) {
    console.error(renderAmbiguousMatch(e, args));
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
}
