/**
 * maw consent — CLI dispatcher (#644 Phase 1).
 *
 *   maw consent                          alias for `list`
 *   maw consent list                     pending requests
 *   maw consent approve <id> <pin>       approve + write trust
 *   maw consent reject <id>              reject without trust
 *   maw consent trust <peer> [action]    pre-approve (default action=hey)
 *   maw consent untrust <peer> [action]  revoke trust entry
 *   maw consent list-trust               show all trust entries
 */
import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import {
  listPending, listTrust, recordTrust, removeTrust,
  approveConsent, rejectConsent, type ConsentAction,
} from "../../../core/consent";
import { loadConfig } from "../../../config";

const VALID_ACTIONS: ConsentAction[] = ["hey", "team-invite", "plugin-install"];

function help(): string {
  return [
    "usage:",
    "  maw consent                            list pending requests (alias for `list`)",
    "  maw consent list                       list pending requests",
    "  maw consent list-trust                 list approved trust entries",
    "  maw consent approve <id> <pin>         approve a pending request",
    "  maw consent reject <id>                reject a pending request",
    "  maw consent trust <peer> [action]      pre-approve trust (default action=hey)",
    "  maw consent untrust <peer> [action]    revoke trust entry",
    "",
    "actions: hey | team-invite | plugin-install",
    "consent gating is opt-in via MAW_CONSENT=1 (Phase 1).",
  ].join("\n");
}

function fmtPending(rows: ReturnType<typeof listPending>): string {
  if (!rows.length) return "no pending consent requests";
  const lines = ["id                        from → to             action            status   summary"];
  for (const r of rows) {
    const id = r.id.padEnd(24);
    const fromTo = `${r.from} → ${r.to}`.padEnd(20);
    const act = r.action.padEnd(16);
    const st = r.status.padEnd(8);
    const sum = r.summary.length > 50 ? r.summary.slice(0, 47) + "…" : r.summary;
    lines.push(`${id}  ${fromTo}  ${act}  ${st}  ${sum}`);
  }
  return lines.join("\n");
}

function fmtTrust(rows: ReturnType<typeof listTrust>): string {
  if (!rows.length) return "no trust entries";
  const lines = ["from → to                action            approvedAt"];
  for (const r of rows) {
    const fromTo = `${r.from} → ${r.to}`.padEnd(22);
    const act = r.action.padEnd(16);
    lines.push(`${fromTo}  ${act}  ${r.approvedAt}`);
  }
  return lines.join("\n");
}

export const command = { name: "consent", description: "PIN-consent for cross-oracle actions (#644)." };

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const positional = args.filter(a => !a.startsWith("--"));

  const sub = positional[0] ?? "list";

  try {
    if (sub === "list") {
      return { ok: true, output: fmtPending(listPending()) };
    }

    if (sub === "list-trust") {
      return { ok: true, output: fmtTrust(listTrust()) };
    }

    if (sub === "approve") {
      const id = positional[1];
      const pin = positional[2];
      if (!id || !pin) return { ok: false, error: "usage: maw consent approve <id> <pin>" };
      const r = await approveConsent(id, pin);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, output: `✅ approved ${id} — trust written for ${r.entry?.from} → ${r.entry?.to}:${r.entry?.action}` };
    }

    if (sub === "reject") {
      const id = positional[1];
      if (!id) return { ok: false, error: "usage: maw consent reject <id>" };
      const r = rejectConsent(id);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, output: `✗ rejected ${id}` };
    }

    if (sub === "trust") {
      const peer = positional[1];
      const action = (positional[2] ?? "hey") as ConsentAction;
      if (!peer) return { ok: false, error: "usage: maw consent trust <peer> [action]" };
      if (!VALID_ACTIONS.includes(action)) return { ok: false, error: `unknown action '${action}' — expected: ${VALID_ACTIONS.join(", ")}` };
      const myNode = loadConfig().node ?? "local";
      recordTrust({
        from: myNode, to: peer, action,
        approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
      });
      return { ok: true, output: `✅ trust written: ${myNode} → ${peer}:${action}` };
    }

    if (sub === "untrust") {
      const peer = positional[1];
      const action = (positional[2] ?? "hey") as ConsentAction;
      if (!peer) return { ok: false, error: "usage: maw consent untrust <peer> [action]" };
      if (!VALID_ACTIONS.includes(action)) return { ok: false, error: `unknown action '${action}'` };
      const myNode = loadConfig().node ?? "local";
      const removed = removeTrust(myNode, peer, action);
      return { ok: true, output: removed ? `✗ removed: ${myNode} → ${peer}:${action}` : `(no trust entry for ${myNode} → ${peer}:${action})` };
    }

    if (sub === "help" || sub === "--help" || sub === "-h") {
      return { ok: true, output: help() };
    }

    return { ok: false, error: `unknown subcommand: ${sub}\n\n${help()}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
