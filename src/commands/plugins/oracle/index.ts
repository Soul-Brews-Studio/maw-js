import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdOracleList, cmdOracleAbout, cmdOracleScan, cmdOracleScanStale } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: ["oracle", "oracles"],
  description: "Oracle management — list, scan, about (fleet deprecated → ls)",
};

// Shared spec for `ls` flags — used by both ls and the fleet alias.
const LS_FLAGS = {
  "--json": Boolean,
  "--awake": Boolean,
  "--scan": Boolean,
  "--stale": Boolean,
  "--org": String,
  "--path": Boolean,
  "-p": "--path",
} as const;

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
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const subcmd = args[0]?.toLowerCase();
      if (!subcmd || subcmd === "ls" || subcmd === "list") {
        const flags = parseFlags(args, LS_FLAGS, 1);
        await cmdOracleList({
          awake: flags["--awake"],
          org: flags["--org"],
          json: flags["--json"],
          scan: flags["--scan"],
          stale: flags["--stale"],
          path: flags["--path"],
        });
      } else if (subcmd === "scan") {
        const flags = parseFlags(args, {
          "--json": Boolean,
          "--force": Boolean,
          "--local": Boolean,
          "--remote": Boolean,
          "--all": Boolean,
          "--stale": Boolean,
          "--verbose": Boolean,
          "-v": "--verbose",
          "--quiet": Boolean,
          "-q": "--quiet",
        }, 1);
        if (flags["--stale"]) {
          await cmdOracleScanStale({
            json: flags["--json"],
            all: flags["--all"],
          });
        } else {
          await cmdOracleScan({
            json: flags["--json"],
            force: flags["--force"],
            local: flags["--local"],
            remote: flags["--remote"],
            all: flags["--all"],
            verbose: flags["--verbose"],
            quiet: flags["--quiet"],
          });
        }
      } else if (subcmd === "fleet") {
        // Deprecated alias — warn then delegate to ls.
        console.error(
          `\x1b[33m⚠  maw oracle fleet is deprecated — use \x1b[36mmaw oracle ls\x1b[0m\x1b[33m instead\x1b[0m`,
        );
        const flags = parseFlags(args, LS_FLAGS, 1);
        await cmdOracleList({
          awake: flags["--awake"],
          org: flags["--org"],
          json: flags["--json"],
          scan: flags["--scan"],
          stale: flags["--stale"],
          path: flags["--path"],
        });
      } else if (subcmd === "about" && args[1]) {
        await cmdOracleAbout(args[1]);
      } else {
        return { ok: false, error: "usage: maw oracle [ls|scan|about <name>]" };
      }
    } else if (ctx.source === "api") {
      const query = ctx.args as Record<string, unknown>;
      const sub = (query.sub as string | undefined)?.toLowerCase();
      if (!sub || sub === "ls" || sub === "list") {
        await cmdOracleList({
          awake: query.awake as boolean | undefined,
          org: query.org as string | undefined,
          json: query.json as boolean | undefined,
          scan: query.scan as boolean | undefined,
          stale: query.stale as boolean | undefined,
          path: query.path as boolean | undefined,
        });
      } else if (sub === "scan") {
        if (query.stale) {
          await cmdOracleScanStale({
            json: query.json as boolean | undefined,
            all: query.all as boolean | undefined,
          });
        } else {
          await cmdOracleScan({
            json: query.json as boolean | undefined,
            force: query.force as boolean | undefined,
            local: query.local as boolean | undefined,
            remote: query.remote as boolean | undefined,
            all: query.all as boolean | undefined,
            verbose: query.verbose as boolean | undefined,
          });
        }
      } else if (sub === "fleet") {
        console.error(
          `\x1b[33m⚠  oracle.fleet is deprecated — use oracle.ls\x1b[0m`,
        );
        await cmdOracleList({
          awake: query.awake as boolean | undefined,
          org: query.org as string | undefined,
          json: query.json as boolean | undefined,
          scan: query.scan as boolean | undefined,
          stale: query.stale as boolean | undefined,
          path: query.path as boolean | undefined,
        });
      } else if (sub === "about" && query.name) {
        await cmdOracleAbout(query.name as string);
      } else {
        return { ok: false, error: "usage: query.sub=[ls|scan|about] + query.name for about" };
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
