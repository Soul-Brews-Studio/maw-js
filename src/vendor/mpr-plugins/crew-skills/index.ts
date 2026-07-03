/**
 * maw crew-skills — install/refresh the global /crew + /warroom skills and the
 * worker Stop hook in ~/.claude.
 *
 *   maw crew-skills            → sync (install/refresh)
 *   maw crew-skills sync       → same
 *   maw crew-skills --dry-run  → report what would change
 *   maw crew-skills --force    → rewrite even if unchanged
 */

import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { formatSyncResult, syncCrewSkills } from "./sync";

export const command = {
  name: "crew-skills",
  description:
    "Install/refresh the global /crew + /warroom skills and worker Stop hook in ~/.claude.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args: string[] = ctx.source === "cli" && Array.isArray(ctx.args) ? (ctx.args as string[]) : [];
  const positionals = args.filter((a) => !a.startsWith("-"));
  const sub = positionals[0] ?? "sync";
  if (sub !== "sync") {
    return { ok: false, error: `unknown subcommand '${sub}' (expected: sync)`, output: "" };
  }

  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const force = args.includes("--force") || args.includes("-f");

  try {
    const result = syncCrewSkills({ dryRun, force });
    const output = formatSyncResult(result);
    ctx.writer?.(output);
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: "" };
  }
}
