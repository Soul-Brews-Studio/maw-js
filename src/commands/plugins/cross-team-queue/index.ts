/**
 * cross-team-queue — unified inbox view across oracle vaults.
 *
 * Auto-mounted at GET /api/plugins/cross-team-queue by src/api/index.ts.
 *
 * Prior art (inspiration, not code): #505 by david-oracle — built-in router
 * shape for the same feature. This plugin-first version exists to make the
 * "API features land as plugins" recommendation concrete. See #515.
 *
 * Response shape: { items: InboxItem[], stats: QueueStats, errors: ParseError[] }.
 * VAULT_ROOT is required (MAW_VAULT_ROOT env) — missing → loud error in errors[].
 */

import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { scanVault } from "./scan";
import type { QueueFilter, QueueResponse } from "./types";

export const command = {
  name: "cross-team-queue",
  description: "Unified inbox across oracle vaults — scans ψ/memory/<oracle>/inbox/*.md.",
};

function coerceFilter(src: Partial<Record<keyof QueueFilter, unknown>>): QueueFilter {
  const f: QueueFilter = {};
  if (typeof src.recipient === "string" && src.recipient) f.recipient = src.recipient;
  if (typeof src.team === "string" && src.team) f.team = src.team;
  if (typeof src.type === "string" && src.type) f.type = src.type;
  const age = src.maxAgeHours;
  if (typeof age === "number" && Number.isFinite(age)) f.maxAgeHours = age;
  else if (typeof age === "string" && age !== "" && Number.isFinite(Number(age))) {
    f.maxAgeHours = Number(age);
  }
  return f;
}

function formatCli(r: QueueResponse): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  \x1b[36mcross-team-queue\x1b[0m — ${r.stats.totalReturned}/${r.stats.totalScanned} items across ${r.stats.oracles} oracle(s)`);
  if (r.errors.length) {
    lines.push(`  \x1b[33m⚠ ${r.errors.length} parse error(s)\x1b[0m`);
    for (const e of r.errors.slice(0, 5)) lines.push(`    \x1b[90m${e.file}\x1b[0m — ${e.reason}`);
    if (r.errors.length > 5) lines.push(`    \x1b[90m... and ${r.errors.length - 5} more\x1b[0m`);
  }
  if (!r.items.length) {
    lines.push(`  \x1b[90m○\x1b[0m no items`);
    lines.push("");
    return lines.join("\n");
  }
  for (const item of r.items.slice(0, 25)) {
    const age = item.ageHours < 1 ? `${Math.round(item.ageHours * 60)}m` : `${Math.round(item.ageHours)}h`;
    const subj = item.subject ?? item.file.split("/").pop() ?? item.file;
    const to = item.recipient ? ` → ${item.recipient}` : "";
    lines.push(`  \x1b[90m${age.padStart(4)}\x1b[0m ${item.oracle}${to}: ${subj}`);
  }
  if (r.items.length > 25) lines.push(`  \x1b[90m... and ${r.items.length - 25} more\x1b[0m`);
  lines.push("");
  return lines.join("\n");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    let filter: QueueFilter;
    if (ctx.source === "cli") {
      const flags = parseFlags(ctx.args as string[], {
        "--recipient": String,
        "--team": String,
        "--type": String,
        "--max-age-hours": Number,
        "--json": Boolean,
      }, 0);
      filter = coerceFilter({
        recipient: flags["--recipient"],
        team: flags["--team"],
        type: flags["--type"],
        maxAgeHours: flags["--max-age-hours"],
      });
      const result = scanVault(filter);
      const asJson = Boolean(flags["--json"]);
      const output = asJson ? JSON.stringify(result, null, 2) : formatCli(result);
      if (ctx.writer) ctx.writer(output);
      return { ok: true, output };
    }
    const body = (ctx.args as Record<string, unknown>) ?? {};
    filter = coerceFilter({
      recipient: body.recipient,
      team: body.team,
      type: body.type,
      maxAgeHours: body.maxAgeHours ?? body["max-age-hours"] ?? body["max_age_hours"],
    });
    const result = scanVault(filter);
    return { ok: true, output: JSON.stringify(result) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
