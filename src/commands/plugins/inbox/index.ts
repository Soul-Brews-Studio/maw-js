import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  cmdInboxLs,
  cmdInboxMarkRead,
  cmdInboxRead,
  cmdInboxWrite,
  cmdQueueList,
  cmdApprove,
  cmdReject,
  cmdShow,
  formatQueueList,
  formatQueueDetail,
} from "./impl";

export const command = {
  name: "inbox",
  description: "Inbox messages + cross-scope approval queue (#842 Sub-C).",
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
  const out = () => logs.join("\n");
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    // ─── Approval queue subcommands (#842 Sub-C) ───
    if (sub === "pending" || sub === "queue") {
      // maw inbox pending — list pending approval-queue messages.
      const rows = cmdQueueList();
      console.log(formatQueueList(rows));
      return { ok: true, output: out() };
    }
    if (sub === "approve") {
      const id = args[1];
      if (!id) {
        return { ok: false, error: "usage: maw inbox approve <id>", output: out() };
      }
      try {
        const approved = await cmdApprove(id);
        console.log(`approved: ${approved.id} (${approved.sender} → ${approved.target})`);
        return { ok: true, output: out() };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e), output: out() };
      }
    }
    if (sub === "reject") {
      const id = args[1];
      if (!id) {
        return { ok: false, error: "usage: maw inbox reject <id>", output: out() };
      }
      try {
        const rejected = cmdReject(id);
        console.log(`rejected: ${rejected.id} (${rejected.sender} → ${rejected.target})`);
        return { ok: true, output: out() };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e), output: out() };
      }
    }
    if (sub === "show-pending" || sub === "pending-show") {
      const id = args[1];
      if (!id) {
        return { ok: false, error: "usage: maw inbox show-pending <id>", output: out() };
      }
      const msg = cmdShow(id);
      if (!msg) {
        return { ok: false, error: `pending message not found: ${id}`, output: out() };
      }
      console.log(formatQueueDetail(msg));
      return { ok: true, output: out() };
    }

    // ─── Legacy ψ/inbox/ subcommands ───
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
