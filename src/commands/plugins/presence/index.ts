/**
 * maw presence — set this pane's presence state (mawjs-3 / kobo-113).
 *
 *   maw presence away   → durable worklog "away" event for this oracle/pane
 *   maw presence back    → clears it (idle), receiving hey normally again
 *
 * SILENT by design (Tony): a purely local worklog write, ZERO outbound message —
 * "ไปห้องน้ำไม่ต้อง broadcast, แค่ set ไว้". The effect surfaces only when someone
 * tries to `maw hey` this pane while away: the delivery gate parks the message to
 * the inbox and tells the SENDER "parked, wait for seat" (see comm-send.ts). seat
 * drains the inbox on return.
 *
 * Reuses the worklog store (kobo-109/111 idle/error pattern, newest-wins) — no new
 * store. Intended caller: the /toilet + /seat skills (follow-up, shipped separately
 * via skill distribution — NOT this repo).
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { execFileSync } from "child_process";
import { appendWorklog } from "../../../core/worklog/store";
// Same barrel-free resolver the delivery gate reads with (isOracleAway) → the away
// event is written to, and read from, the same company worklog.
import { companyOfOracleLight } from "../../../core/worklog/presence-away";

export const command = {
  name: "presence",
  description: "Set this pane's presence (away/back) — a silent local write; parks incoming hey to inbox until seat.",
};

/** Same resolution the worklog hooks use: CLAUDE_AGENT_NAME, else tmux session name minus prefix. */
function resolveOracle(): string {
  const env = process.env.CLAUDE_AGENT_NAME?.trim();
  if (env) return env;
  try {
    const s = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf8" });
    return s.trim().replace(/^[0-9]*-/, "") || "unknown";
  } catch {
    return "unknown";
  }
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" && Array.isArray(ctx.args) ? (ctx.args as string[]) : [];
  const sub = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  const write = (s: string) => { if (ctx.writer) ctx.writer(s); };

  if (sub !== "away" && sub !== "back") {
    return { ok: false, error: "usage: maw presence <away|back>", output: "" };
  }

  const oracle = resolveOracle();
  const company = companyOfOracleLight(oracle) ?? undefined;
  const paneId = process.env.TMUX_PANE || undefined;
  const now = Date.now();
  appendWorklog({
    ts: now,
    iso: new Date(now).toISOString(),
    oracle,
    company,
    ...(paneId ? { paneId } : {}),
    kind: sub === "away" ? "away" : "idle",
    summary: sub === "away" ? "away (stepped out)" : "back (returned)",
  });

  write(sub === "away"
    ? "\x1b[33m○ away\x1b[0m — incoming hey parks to your inbox until you seat (nothing broadcast)"
    : "\x1b[32m● back\x1b[0m — receiving hey normally again");
  return { ok: true, output: "" };
}
