import { hostExec } from "../../../sdk";
import { UserError } from "../../../core/util/user-error";

/**
 * maw whoami — print the current tmux session name on stdout.
 * Replaces scattered raw `tmux display-message -p '#S'` calls with one
 * canonical, testable command.
 */
export async function cmdWhoami() {
  if (!process.env.TMUX) {
    throw new UserError("maw whoami requires an active tmux session — run 'maw wake <oracle>' or attach to tmux first");
  }
  const raw = await hostExec(`tmux display-message -p '#S'`);
  console.log(raw.trim());
}
