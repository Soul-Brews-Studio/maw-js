import {
  cmdTeamWtfFix as vendorCmdTeamWtfFix,
  type WtfFixApplyDeps,
  type WtfFixPlanResult,
} from "../../../vendor/mpr-plugins/team/team-wtf-fix";
import { installStandardPlugins, inspectStandardPluginHealth, standardPluginHealthMessage } from "../../shared/standard-plugins";

export * from "../../../vendor/mpr-plugins/team/team-wtf-fix";

function standardPluginsNeedFix(): boolean {
  return Boolean(standardPluginHealthMessage(inspectStandardPluginHealth()));
}

export async function cmdTeamWtfFix(teamArg: string | undefined, opts: { json?: boolean; session?: string; cwd?: string; confirm?: string; dryRun?: boolean } = {}, deps: WtfFixApplyDeps & any = {}): Promise<WtfFixPlanResult> {
  if (standardPluginsNeedFix()) {
    const command = "maw plugin install --standard";
    const plan: WtfFixPlanResult = {
      transactions: [{ kind: "team-up", command, check: "plugins:standard-set" } as any],
      denied: [],
      commands: [command],
    };
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log("maw wtf --fix plan");
      console.log(`  + ${command}`);
    }
    if (!opts.dryRun) await installStandardPlugins();
    return plan;
  }
  return vendorCmdTeamWtfFix(teamArg, opts, deps);
}
