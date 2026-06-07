import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import {
  cmdInboxLs,
  cmdInboxDrain,
  cmdInboxMarkRead,
  cmdInboxRead,
  cmdInboxStatus,
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

function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max" || arg === "--older-than-hours") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

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
    } else if (sub === "drain") {
      // maw inbox drain [oracle-name] --safe [--max N] [--older-than-hours H] [--json] [--dry-run]
      const rest = args.slice(1);
      const positions = positionalArgs(rest);
      const maxRaw = flagValue(rest, "--max");
      const olderRaw = flagValue(rest, "--older-than-hours");
      const max = maxRaw === undefined ? undefined : parseInt(maxRaw, 10);
      const olderHours = olderRaw === undefined ? undefined : parseFloat(olderRaw);
      const hasMaxFlag = rest.some(arg => arg === "--max" || arg.startsWith("--max="));
      const hasOlderFlag = rest.some(arg => arg === "--older-than-hours" || arg.startsWith("--older-than-hours="));
      if (positions.length > 1 || !rest.includes("--safe")) {
        return { ok: false, error: "usage: maw inbox drain [oracle-name] --safe [--max N] [--older-than-hours H] [--json] [--dry-run]", output: out() };
      }
      if (hasMaxFlag && (maxRaw === undefined || maxRaw === "" || !Number.isFinite(max) || max < 0)) {
        return { ok: false, error: "--max must be a non-negative integer", output: out() };
      }
      if (hasOlderFlag && (olderRaw === undefined || olderRaw === "" || !Number.isFinite(olderHours) || olderHours < 0)) {
        return { ok: false, error: "--older-than-hours must be a non-negative number", output: out() };
      }
      await cmdInboxDrain(positions[0], {
        safe: true,
        json: rest.includes("--json"),
        dryRun: rest.includes("--dry-run"),
        max,
        olderThanSeconds: olderHours === undefined ? undefined : olderHours * 60 * 60,
      });
    } else if (sub === "status") {
      // maw inbox status [oracle-name] [--json] [--all] — red/green unread backpressure.
      const rest = args.slice(1);
      const json = rest.includes("--json");
      const all = rest.includes("--all");
      const oracle = rest.find(a => !a.startsWith("-"));
      if (all && oracle) {
        return { ok: false, error: "usage: maw inbox status [oracle-name] [--json] [--all]", output: out() };
      }
      await cmdInboxStatus(oracle, { json, all });
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
