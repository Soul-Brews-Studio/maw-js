import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdTokens } from "./tokens";
import { cmdStatus } from "./status";
import { cmdBind } from "./bind";
import { cmdAccess } from "./access";
import { cmdGuilds, cmdChannels, cmdMembers, cmdInventory } from "./inventory";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const command = {
  name: "discord",
  description: "Discord fleet ops — tokens, status, bind, (pair/route/serve coming).",
};

function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function printVersion(log: (s: string) => void): void {
  log(`maw discord v${getVersion()}`);
  log("");
  log("subcommand status:");
  log("  ✓ tokens ls / check        v0.1");
  log("  ✓ status [bot] [flags]     v0.3.1 (real online/where via bun ancestry)");
  log("  ✓ bind <bot>               v0.3 (rewrite to use 'maw wake' pending)");
  log("  ✓ access <bot> ...         v0.4 (list/show/map/add/rm/set/allow/lockdown)");
  log("  ✓ guilds/channels/members/inventory <bot>  v0.4.2 (Discord-state visibility)");
  log("  ⏸ pair <oracle> <chan>     v0.5 planned");
  log("  ⏸ route <from> <to>        v0.5 planned");
  log("  ⏸ serve (after_send hook)  v0.5 planned (replaces daemon — engine.serve)");
}

function printUsage(log: (s: string) => void): void {
  log("usage: maw discord <subcommand> [args]");
  log("");
  log("subcommands:");
  log("  version                            show plugin version + subcommand status");
  log("  tokens ls                          list all Discord bot tokens in pass (no reveal)");
  log("  tokens check [bot]                 verify each token decrypts + Discord REST 200");
  log("  status [bot] [--check] [--redact] [--json]");
  log("                                     fleet inspection from this host — pass × legacy × hybrid × tmux × registry");
  log("  bind <bot> [--apply] [--restart] [--session <name>] [--force]");
  log("                                     end-to-end Discord-online for a bot on this host");
  log("  access <bot> <list|show|map|add|rm|set|allow|lockdown> [...]");
  log("                                     channel + allowlist management per bot (NEW v0.4)");
  log("");
  log("subcommands (planned):");
  log("  pair <oracle> <channel>            access.json + channel-map.json bootstrap (v0.5)");
  log("  route <from> <to>                  channel-map.json entry (v0.5)");
  log("  serve (hook handler)               wires after_send → Discord post (v0.5)");
  log("");
  log("token strategy: HYBRID — tokens in pass (central), .discord/ config in bot repo.");
  log("see: ψ/outbox/ideas/2026-05-17_self-contained-bot-repo-gpg-pattern.md");
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const log = (s: string) => {
    if (ctx.writer) ctx.writer(s);
    else logs.push(s);
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
      printUsage(log);
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "version" || sub === "-v" || sub === "--version") {
      printVersion(log);
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "tokens") {
      const action = args[1]?.toLowerCase();
      if (!action || action === "ls") {
        await cmdTokens.ls(log);
      } else if (action === "check") {
        await cmdTokens.check(log, args[2]);
      } else {
        log(`unknown subcommand: tokens ${action}`);
        log("usage: maw discord tokens <ls|check> [bot]");
        return { ok: false, error: `unknown action: ${action}`, output: logs.join("\n") };
      }
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "status") {
      await cmdStatus.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "bind") {
      await cmdBind.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "access") {
      await cmdAccess.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "guilds") {
      await cmdGuilds.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "channels") {
      await cmdChannels.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "members") {
      await cmdMembers.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "inventory") {
      await cmdInventory.run(log, args.slice(1));
      return { ok: true, output: logs.join("\n") };
    }

    if (sub === "pair" || sub === "route" || sub === "serve") {
      log(`✗ '${sub}' not implemented yet (v0.4 ships tokens + status + bind + access).`);
      log("planned for v0.5 — see 'maw discord' for full subcommand list.");
      return { ok: false, error: `${sub} not implemented`, output: logs.join("\n") };
    }

    log(`unknown subcommand: ${sub}`);
    printUsage(log);
    return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") };
  }
}
