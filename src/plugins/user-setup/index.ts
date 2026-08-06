import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import {
  auditClaudeProjects,
  planUserSetupPrune,
  renderUserSetupPlan,
  USER_SETUP_AUDIT_USAGE,
  USER_SETUP_USAGE,
} from "./impl";

export const command = {
  name: "user-setup",
  description: "Audit local Claude project logs and report prune candidates.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.args ?? [];
  const flags = parseFlags(args, {
    "--dry-run": Boolean,
    "--json": Boolean,
  }, 0);

  const [scope, action] = flags._;
  if (!scope) {
    const plan = await planUserSetupPrune({ dryRun: true });
    return { ok: true, output: renderUserSetupPlan(plan) };
  }

  if (scope !== "projects" || action !== "audit") {
    return { ok: false, error: USER_SETUP_USAGE, output: USER_SETUP_USAGE, exitCode: 2 };
  }
  if (!flags["--json"]) {
    return {
      ok: false,
      error: `${USER_SETUP_AUDIT_USAGE}\n\nOnly --json is implemented in the first read-only #1934 slice.`,
      output: USER_SETUP_AUDIT_USAGE,
      exitCode: 2,
    };
  }

  try {
    const result = await auditClaudeProjects();
    return { ok: true, output: JSON.stringify(result, null, 2) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, exitCode: 1 };
  }
}
