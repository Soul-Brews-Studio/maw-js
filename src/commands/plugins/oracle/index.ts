import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdOracleList, cmdOracleAbout, cmdOracleScan, cmdOracleFleet } from "../../oracle";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: ["oracle", "oracles"],
  description: "Oracle management — list, scan, fleet, about",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const subcmd = args[0]?.toLowerCase();
      if (!subcmd || subcmd === "ls" || subcmd === "list") {
        await cmdOracleList();
      } else if (subcmd === "scan") {
        const flags = parseFlags(args, {
          "--json": Boolean,
          "--force": Boolean,
          "--local": Boolean,
          "--remote": Boolean,
          "--all": Boolean,
          "--verbose": Boolean,
          "-v": "--verbose",
        }, 1);
        await cmdOracleScan({
          json: flags["--json"],
          force: flags["--force"],
          local: flags["--local"],
          remote: flags["--remote"],
          all: flags["--all"],
          verbose: flags["--verbose"],
        });
      } else if (subcmd === "fleet") {
        const flags = parseFlags(args, {
          "--json": Boolean,
          "--stale": Boolean,
          "--org": String,
        }, 1);
        await cmdOracleFleet({ json: flags["--json"], stale: flags["--stale"], org: flags["--org"] });
      } else if (subcmd === "about" && args[1]) {
        await cmdOracleAbout(args[1]);
      } else {
        return { ok: false, error: "usage: maw oracle [ls|scan|fleet|about <name>]" };
      }
    } else if (ctx.source === "api") {
      const query = ctx.args as Record<string, unknown>;
      const sub = (query.sub as string | undefined)?.toLowerCase();
      if (!sub || sub === "ls" || sub === "list") {
        await cmdOracleList();
      } else if (sub === "scan") {
        await cmdOracleScan({
          json: query.json as boolean | undefined,
          force: query.force as boolean | undefined,
          local: query.local as boolean | undefined,
          remote: query.remote as boolean | undefined,
          all: query.all as boolean | undefined,
          verbose: query.verbose as boolean | undefined,
        });
      } else if (sub === "fleet") {
        await cmdOracleFleet({
          json: query.json as boolean | undefined,
          stale: query.stale as boolean | undefined,
          org: query.org as string | undefined,
        });
      } else if (sub === "about" && query.name) {
        await cmdOracleAbout(query.name as string);
      } else {
        return { ok: false, error: "usage: query.sub=[ls|scan|fleet|about] + query.name for about" };
      }
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
