import type { DoctorCheck } from "../../../vendor/mpr-plugins/doctor/impl";
import {
  cmdTeamWtf as vendorCmdTeamWtf,
  inspectTeamWtf as vendorInspectTeamWtf,
  type TeamWtfDeps,
  type TeamWtfOptions,
  type TeamWtfResult,
} from "../../../vendor/mpr-plugins/team/team-wtf";
import { formatStandardPluginHint, inspectStandardPluginHealth, standardPluginHealthMessage } from "../../shared/standard-plugins";

export * from "../../../vendor/mpr-plugins/team/team-wtf";

function pluginHealthCheck(): DoctorCheck | undefined {
  const health = inspectStandardPluginHealth();
  const message = standardPluginHealthMessage(health);
  if (!message) return undefined;
  return {
    name: "plugins:standard-set",
    ok: false,
    severity: health.status === "missing" ? "error" : "warn",
    message,
    fix: ["maw plugin install --standard"],
    details: { ...health, verb: "install-standard" },
  };
}

function renderPluginCheck(check: DoctorCheck): void {
  const icon = check.severity === "error" ? "❌" : "⚠️";
  console.log(`${icon} ${check.name.padEnd(26)} ${check.message}`);
  console.log(`   → ${formatStandardPluginHint()}`);
}

function pluginOnlyResult(check: DoctorCheck): TeamWtfResult {
  return {
    ok: false,
    team: "plugins",
    session: "plugin-bootstrap",
    charterPath: "(standard plugin set)",
    checks: [check],
  };
}

export async function inspectTeamWtf(teamArg: string | undefined, opts: TeamWtfOptions = {}, deps: TeamWtfDeps = {}): Promise<TeamWtfResult> {
  const check = pluginHealthCheck();
  if (check && !teamArg) return pluginOnlyResult(check);
  const result = await vendorInspectTeamWtf(teamArg, opts, deps);
  return check ? { ...result, ok: false, checks: [check, ...result.checks] } : result;
}

export async function cmdTeamWtf(teamArg?: string, opts: TeamWtfOptions = {}, deps: TeamWtfDeps = {}): Promise<TeamWtfResult> {
  const check = pluginHealthCheck();
  if (check && !teamArg) {
    const result = pluginOnlyResult(check);
    if (opts.json) console.log(JSON.stringify({ ok: false, checks: result.checks }, null, 2));
    else renderPluginCheck(check);
    return result;
  }
  if (check && !opts.json) renderPluginCheck(check);
  const result = await vendorCmdTeamWtf(teamArg, opts, deps);
  return check ? { ...result, ok: false, checks: [check, ...result.checks] } : result;
}
