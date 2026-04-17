import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdInboxLs, cmdInboxMarkRead, cmdInboxRead, cmdInboxWrite } from "./impl";

export const command = {
  name: "inbox",
  description: "List and manage agent inbox messages (ψ/inbox/ thread-backed).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "read") {
      // maw inbox read <id>  — mark as read
      await cmdInboxMarkRead(args[1] ?? "");
    } else if (sub === "show") {
      // maw inbox show [N|name]  — display content of a message
      await cmdInboxRead(args[1]);
    } else if (sub === "write" && args[1]) {
      await cmdInboxWrite(args.slice(1).join(" "));
    } else {
      // maw inbox [--unread] [--from <peer>] [--last N]
      const unread = args.includes("--unread");
      const fromIdx = args.indexOf("--from");
      const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
      const lastIdx = args.indexOf("--last");
      const last = lastIdx >= 0 ? (parseInt(args[lastIdx + 1] ?? "20") || 20) : undefined;
      await cmdInboxLs({ unread, from, last });
    }
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
