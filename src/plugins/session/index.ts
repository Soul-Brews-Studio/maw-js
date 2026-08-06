import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { hostExec } from "../../../sdk";
import { UserError } from "../../../core/util/user-error";

export const command = {
  name: "session",
  description: "Alias of `maw whoami` — prints session + window + pane address. --short for #S only, --json for machine-readable.",
};

/**
 * `session` and `whoami` are 1:1 aliases. #1916 LOW-2 enriches the human
 * output for both; the implementation is inlined here (per #953) so this
 * file does not depend on the registry plugin. Keep behavior in sync with
 * `src/vendor/mpr-plugins/whoami/impl.ts::cmdWhoami`.
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
    const argv = (ctx.source === "cli" ? (ctx.args as string[]) : []) ?? [];
    const short = argv.includes("--short") || argv.includes("-s");
    const json = argv.includes("--json");

    if (short) {
      const raw = await hostExec(`tmux display-message -p '#S'`);
      console.log(raw.trim());
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const raw = await hostExec(`tmux display-message -p '#S\t#W\t#{window_id}\t#{pane_title}\t#{pane_id}'`);
    const [session, window, windowId, paneTitle, paneId] = raw.trim().split("\t");

    if (json) {
      console.log(JSON.stringify({
        session: session || "",
        window: window || "",
        window_id: windowId || "",
        pane_title: paneTitle || "",
        pane_id: paneId || "",
        target: `${session}:${window}.${(paneId ?? "").replace(/^%/, "")}`,
      }));
    } else {
      console.log(`session  ${session}`);
      console.log(`window   ${window}  \x1b[90m(${windowId})\x1b[0m`);
      console.log(`pane     ${paneTitle}  \x1b[90m(${paneId})\x1b[0m`);
      console.log(`target   \x1b[36m${session}:${window}\x1b[0m  (or ${paneId} for the exact pane)`);
    }
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
