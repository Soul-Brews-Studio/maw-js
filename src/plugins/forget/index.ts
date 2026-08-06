import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdForget } from "./impl";

export const command = { name: "forget", description: "Exhaustively remove stale local oracle runtime state." };
const USAGE = "usage: maw forget <oracle> [--dry-run] [--yes|--force] [--json]";

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log, origError = console.error;
  console.log = (...a: any[]) => ctx.writer ? ctx.writer(...a) : logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => ctx.writer ? ctx.writer(...a) : logs.push(a.map(String).join(" "));
  try {
    let oracle: string | undefined, dryRun = false, yes = false, json = false;
    if (ctx.source === "cli") {
      const flags = parseFlags(ctx.args as string[], { "--dry-run": Boolean, "--yes": Boolean, "-y": "--yes", "--force": Boolean, "--json": Boolean });
      oracle = flags._[0]; dryRun = !!flags["--dry-run"]; yes = !!(flags["--yes"] || flags["--force"]); json = !!flags["--json"];
      if (!oracle || oracle === "--help" || oracle === "-h") return { ok: false, error: USAGE };
      if (flags._.length > 1) return { ok: false, error: `${USAGE}\nunexpected positional args: ${flags._.slice(1).join(" ")}` };
    } else {
      const args = ctx.args as Record<string, unknown>;
      oracle = args.oracle as string | undefined; dryRun = !!(args.dryRun ?? args.dry_run); yes = !!(args.yes ?? args.force); json = !!args.json;
      if (!oracle) return { ok: false, error: "oracle is required" };
    }
    const result = await cmdForget(oracle, { dryRun, yes, json });
    if (json) console.log(JSON.stringify(result, null, 2));
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally { console.log = origLog; console.error = origError; }
}
