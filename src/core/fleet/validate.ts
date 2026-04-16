/**
 * Oracle-name validation — #358.
 *
 * Enforces naming rules at user-input boundaries that create tmux sessions
 * (bud, tiny bud, wake). The `-view` suffix is reserved for ephemeral grouped
 * sessions created by `maw view`; naming an oracle `foo-view` leads to
 * `foo-view-view` chains and session-resolution ambiguity.
 *
 * Keep this tight — only the `-view` rule for now. Other naming rules can be
 * added later if they prove load-bearing.
 *
 * Do NOT call this from low-level Tmux.newSession(): that path legitimately
 * creates `*-view` sessions for the view command. The check belongs at the
 * USER-INPUT boundary (bud/wake) only.
 */
import { UserError } from "../util/user-error";

export function assertValidOracleName(name: string): void {
  if (/-view$/.test(name)) {
    const suggestion = name.replace(/-view$/, "");
    throw new UserError(
      `Oracle name cannot end in '-view' — reserved for ephemeral view sessions. ` +
      `Try '${suggestion}' instead.`,
    );
  }
}
