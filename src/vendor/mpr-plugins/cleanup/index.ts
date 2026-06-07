import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdCleanupZombies } from "./internal/team-cleanup-zombies";
import { cmdPruneStale } from "./internal/prune-stale-oracles";

export const command = {
  name: "cleanup",
  description: "Cleanup zombie agent panes and stale oracles.json entries.",
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
    const has = (...flags: string[]) => flags.some((f) => args.includes(f));

    if (has("--zombie-agents", "--zombies")) {
      await cmdCleanupZombies({ yes: has("--yes", "-y") });
    } else if (has("--prune-stale")) {
      // Default is dry-run preview; --yes prunes SAFE; --ask walks ASK-FIRST.
      // --dry-run is an explicit alias for the default (helps shell history).
      await cmdPruneStale({
        yes: has("--yes", "-y"),
        ask: has("--ask"),
        dryRun: has("--dry-run"),
      });
    } else {
      logs.push("\x1b[36mmaw cleanup\x1b[0m \u2014 Cleanup utilities\n");
      logs.push("  maw cleanup --zombie-agents [--yes]              Find and kill orphan zombie panes");
      logs.push("  maw cleanup --zombies [--yes]                    Alias for --zombie-agents");
      logs.push("  maw cleanup --prune-stale [--yes|--ask|--dry-run]  Prune dead oracles.json entries\n");
      logs.push("\x1b[90mWithout --yes, only lists candidates without modifying anything.\x1b[0m");
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
