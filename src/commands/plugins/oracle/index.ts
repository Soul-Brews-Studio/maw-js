import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdOracleList, cmdOracleAbout, cmdOracleScan, cmdOracleScanStale } from "./impl";
import { cmdOraclePrune } from "./impl-prune";
import { cmdOracleRegister } from "./impl-register";
import { cmdOracleSetNickname, cmdOracleGetNickname } from "./impl-nickname";
import { cmdOracleSearch } from "./impl-search";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: ["oracle", "oracles"],
  description: "Oracle management — list, scan, about, prune, register",
};

// Shared spec for `ls` flags — used by both ls and the fleet alias.
// NOTE: `--new` is NOT declared here. `arg` requires String-typed flags to
// consume a value, but the spec is `--new[=DURATION]` — bare `--new` is valid.
// We pre-process bare `--new` → `--new=7d` before calling parseFlags so arg
// always sees the `=DURATION` form. See `preprocessNewFlag` below.
const LS_FLAGS = {
  "--json": Boolean,
  "--awake": Boolean,
  "--scan": Boolean,
  "--stale": Boolean,
  "--org": String,
  "--path": Boolean,
  "-p": "--path",
  "--new": String,
  "--since": String,
} as const;

/**
 * `--new` has an optional value (`--new` defaults to 7d, `--new=24h` overrides).
 * Convert any bare `--new` token into `--new=7d` so the `arg` parser doesn't
 * choke. `--new=...` and `--new ...` forms are left untouched.
 */
export function preprocessNewFlag(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--new") {
      const next = args[i + 1];
      // If the next token looks like a duration (matches ^\d+[smhdw]$),
      // leave it alone — arg will consume it as the value normally.
      // Otherwise default to 7d via the `=` form.
      if (next && /^\d+[smhdw]$/.test(next)) {
        out.push(a);
      } else {
        out.push("--new=7d");
      }
    } else {
      out.push(a);
    }
  }
  return out;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const subcmd = args[0]?.toLowerCase();
      if (subcmd === "--help" || subcmd === "-h") {
        return {
          ok: true,
          output: `usage: maw oracle <subcommand> [args]

subcommands:
  ls [flags]               list oracles (--json, --awake, --scan, --stale, --org, --path, --new[=DURATION], --since=DATE)
  search <query>           fuzzy search oracles
  scan                     scan ghq for new oracles
  prune                    prune missing/dead oracles
  register <name>          register an oracle
  set-nickname <name> <nick>  set display alias
  get-nickname <name>      get display alias
  rename <old> <new>       full identity rename (#1111)
  about <name>             show oracle details`,
        };
      }
      if (!subcmd || subcmd === "ls" || subcmd === "list") {
        const flags = parseFlags(preprocessNewFlag(args), LS_FLAGS, 1);
        await cmdOracleList({
          awake: flags["--awake"],
          org: flags["--org"],
          json: flags["--json"],
          scan: flags["--scan"],
          stale: flags["--stale"],
          path: flags["--path"],
          new: flags["--new"],
          since: flags["--since"],
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
        const flags = parseFlags(preprocessNewFlag(args), LS_FLAGS, 1);
        await cmdOracleList({
          awake: flags["--awake"],
          org: flags["--org"],
          json: flags["--json"],
          scan: flags["--scan"],
          stale: flags["--stale"],
          path: flags["--path"],
          new: flags["--new"],
          since: flags["--since"],
        });
      } else if (subcmd === "prune") {
        const flags = parseFlags(args, {
          "--stale": Boolean,
          "--force": Boolean,
          "--json": Boolean,
        }, 1);
        await cmdOraclePrune({
          stale: flags["--stale"],
          force: flags["--force"],
          json: flags["--json"],
        });
      } else if (subcmd === "register") {
        const name = args[1];
        if (!name) return { ok: false, error: "usage: maw oracle register <name>" };
        const flags = parseFlags(args, { "--json": Boolean }, 2);
        await cmdOracleRegister(name, { json: flags["--json"] });
      } else if (subcmd === "set-nickname") {
        const name = args[1];
        const nickname = args[2];
        if (!name || nickname === undefined) {
          return { ok: false, error: "usage: maw oracle set-nickname <oracle> \"<nickname>\"" };
        }
        const flags = parseFlags(args, { "--json": Boolean }, 3);
        cmdOracleSetNickname(name, nickname, { json: flags["--json"] });
      } else if (subcmd === "get-nickname") {
        const name = args[1];
        if (!name) return { ok: false, error: "usage: maw oracle get-nickname <oracle>" };
        const flags = parseFlags(args, { "--json": Boolean }, 2);
        cmdOracleGetNickname(name, { json: flags["--json"] });
      } else if (subcmd === "search" || subcmd === "find") {
        const query = args[1];
        if (!query) return { ok: false, error: "usage: maw oracle search <query>" };
        const flags = parseFlags(args, { "--json": Boolean, "--awake": Boolean, "--org": String }, 2);
        await cmdOracleSearch(query, { json: flags["--json"], awake: flags["--awake"], org: flags["--org"] });
      } else if (subcmd === "about" && args[1]) {
        await cmdOracleAbout(args[1]);
      } else if (subcmd === "rename") {
        const oldName = args[1];
        const newName = args[2];
        if (!oldName || !newName) {
          return { ok: false, error: "usage: maw oracle rename <old> <new> [--org <org>] [--dry-run]" };
        }
        const flags = parseFlags(args, { "--org": String, "--dry-run": Boolean }, 3);
        const { cmdOracleRename } = await import("./impl-rename");
        await cmdOracleRename(oldName, newName, { org: flags["--org"], dryRun: flags["--dry-run"] });
      } else {
        return { ok: false, error: "usage: maw oracle [ls|scan|search <query>|prune|register <name>|set-nickname <name> <nickname>|get-nickname <name>|about <name>]" };
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
          new: typeof query.new === "string" ? query.new : (query.new === true ? "7d" : undefined),
          since: query.since as string | undefined,
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
          new: typeof query.new === "string" ? query.new : (query.new === true ? "7d" : undefined),
          since: query.since as string | undefined,
        });
      } else if (sub === "prune") {
        await cmdOraclePrune({
          stale: query.stale as boolean | undefined,
          force: query.force as boolean | undefined,
          json: query.json as boolean | undefined,
        });
      } else if (sub === "register") {
        if (!query.name) return { ok: false, error: "usage: query.sub=register + query.name" };
        await cmdOracleRegister(query.name as string, {
          json: query.json as boolean | undefined,
        });
      } else if (sub === "set-nickname") {
        const name = query.name as string | undefined;
        const nickname = query.nickname as string | undefined;
        if (!name || nickname === undefined) {
          return { ok: false, error: "usage: query.sub=set-nickname + query.name + query.nickname" };
        }
        cmdOracleSetNickname(name, nickname, { json: query.json as boolean | undefined });
      } else if (sub === "get-nickname") {
        if (!query.name) return { ok: false, error: "usage: query.sub=get-nickname + query.name" };
        cmdOracleGetNickname(query.name as string, { json: query.json as boolean | undefined });
      } else if (sub === "search" || sub === "find") {
        if (!query.query) return { ok: false, error: "usage: query.sub=search + query.query" };
        await cmdOracleSearch(query.query as string, {
          json: query.json as boolean | undefined,
          awake: query.awake as boolean | undefined,
          org: query.org as string | undefined,
        });
      } else if (sub === "about" && query.name) {
        await cmdOracleAbout(query.name as string);
      } else {
        return { ok: false, error: "usage: query.sub=[ls|scan|search|prune|register|set-nickname|get-nickname|about] + query.name" };
      }
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
