import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { hostExec } from "../../../sdk";
import { UserError } from "../../../core/util/user-error";

export const command = {
  name: "session",
  description: "Print the current tmux session name (alias of former `maw whoami`).",
};

/**
 * Inlined from the former `whoami/` plugin (extracted to registry in #936).
 * `session/` and `whoami/` were always 1:1 aliases — fix #953 inlines the
 * five-line impl here so `session/` no longer dangles on the deleted module.
 *
 * Behavior preserved:
 *   - Requires an active tmux ($TMUX). Otherwise throws UserError.
 *   - Runs `tmux display-message -p '#S'` via hostExec, prints trimmed.
 *   - Output is captured via ctx.writer (CLI stream) or logs[] (api/peer).
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log, origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    if (!process.env.TMUX) {
      throw new UserError(
        "maw session requires an active tmux session — run 'maw wake <oracle>' or attach to tmux first",
      );
    }
    const raw = await hostExec(`tmux display-message -p '#S'`);
    console.log(raw.trim());
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
