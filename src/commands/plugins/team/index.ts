import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  cmdTeamShutdown, cmdTeamList, cmdTeamCreate, cmdTeamSpawn,
  cmdTeamSend, cmdTeamResume, cmdTeamLives,
} from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "team",
  description: "Agent reincarnation engine — create, spawn, send, shutdown, resume, lives.",
};

/**
 * Best-effort team detection for task verbs (#393 Bug E).
 *
 * 1. If $MAW_TEAM env var is set, use it (explicit override — highest priority).
 * 2. If exactly ONE team exists in ~/.claude/teams/ with a config.json,
 *    that's unambiguous — use it.
 * 3. Otherwise fall back to "default" (preserves legacy behavior).
 *
 * Users who want a specific team should pass --team <name> explicitly.
 */
function resolveTeamFromContext(): string {
  const envTeam = process.env.MAW_TEAM;
  if (envTeam) return envTeam;
  const teamsDir = join(homedir(), ".claude/teams");
  try {
    const live = readdirSync(teamsDir).filter(d =>
      existsSync(join(teamsDir, d, "config.json"))
    );
    if (live.length === 1) return live[0]!;
  } catch { /* no teams dir */ }
  return "default";
}

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
    const sub = args[0]?.toLowerCase();

    if (sub === "create" || sub === "new") {
      if (!args[1]) {
        logs.push("usage: maw team create <name> [--description <text>]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      const descIdx = args.indexOf("--description");
      const description = descIdx !== -1 ? args.slice(descIdx + 1).join(" ") : undefined;
      cmdTeamCreate(args[1], { description });
    } else if (sub === "spawn") {
      if (!args[1] || !args[2]) {
        logs.push("usage: maw team spawn <team> <role> [--model <model>] [--prompt <text>] [--exec]");
        return { ok: false, error: "team and role required", output: logs.join("\n") };
      }
      const modelIdx = args.indexOf("--model");
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
      const promptIdx = args.indexOf("--prompt");
      const exec = args.includes("--exec");
      // --prompt is greedy to end-of-argv; strip --exec if it appears in the tail
      let prompt: string | undefined;
      if (promptIdx !== -1) {
        const tail = args.slice(promptIdx + 1).filter(a => a !== "--exec");
        prompt = tail.join(" ") || undefined;
      }
      await cmdTeamSpawn(args[1], args[2], { model, prompt, exec });
    } else if (sub === "send" || sub === "msg") {
      if (!args[1] || !args[2] || !args[3]) {
        logs.push("usage: maw team send <team> <agent> <message>");
        return { ok: false, error: "team, agent, and message required", output: logs.join("\n") };
      }
      cmdTeamSend(args[1], args[2], args.slice(3).join(" "));
    } else if (sub === "resume") {
      if (!args[1]) {
        logs.push("usage: maw team resume <name> [--model <model>]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      const modelIdx = args.indexOf("--model");
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
      cmdTeamResume(args[1], { model });
    } else if (sub === "lives" || sub === "history") {
      if (!args[1]) {
        logs.push("usage: maw team lives <agent>");
        return { ok: false, error: "agent name required", output: logs.join("\n") };
      }
      cmdTeamLives(args[1]);
    } else if (sub === "shutdown" || sub === "down") {
      if (!args[1]) {
        logs.push("usage: maw team shutdown <name> [--force] [--merge]");
        return { ok: false, error: "name required", output: logs.join("\n") };
      }
      await cmdTeamShutdown(args[1], {
        force: args.includes("--force"),
        merge: args.includes("--merge"),
      });
    } else if (sub === "list" || sub === "ls" || !sub) {
      await cmdTeamList();
    } else if (sub === "add" || sub === "task") {
      // maw team add "subject" [--team <name>] [--assign agent] [--description text]
      const { cmdTeamTaskAdd } = await import("./task-ops");
      const flags = parseFlags(args, {
        "--team": String,
        "--assign": String,
        "--description": String,
      }, 1);
      const subject = flags._.join(" ");
      if (!subject) { logs.push("usage: maw team add <subject> [--team <name>]"); return { ok: false, error: "subject required" }; }
      const team = (flags["--team"] as string | undefined) || resolveTeamFromContext();
      cmdTeamTaskAdd(team, subject, {
        assign: flags["--assign"] as string | undefined,
        description: flags["--description"] as string | undefined,
      });

    } else if (sub === "tasks") {
      // maw team tasks [team-name] [--team <name>]
      const { cmdTeamTaskList } = await import("./task-ops");
      const flags = parseFlags(args, { "--team": String }, 1);
      // Priority: --team flag > positional arg > context detection
      const team = (flags["--team"] as string | undefined)
        || flags._[0]
        || resolveTeamFromContext();
      cmdTeamTaskList(team);

    } else if (sub === "done") {
      // maw team done <id> [--team <name>]
      const { cmdTeamTaskDone } = await import("./task-ops");
      const flags = parseFlags(args, { "--team": String }, 1);
      const id = parseInt(flags._[0] || "");
      if (!id) { return { ok: false, error: "usage: maw team done <task-id> [--team <name>]" }; }
      const team = (flags["--team"] as string | undefined) || resolveTeamFromContext();
      cmdTeamTaskDone(team, id);

    } else if (sub === "assign") {
      // maw team assign <id> <agent> [--team <name>]
      const { cmdTeamTaskAssign } = await import("./task-ops");
      const flags = parseFlags(args, { "--team": String }, 1);
      const id = parseInt(flags._[0] || "");
      const agent = flags._[1];
      if (!id || !agent) { return { ok: false, error: "usage: maw team assign <task-id> <agent> [--team <name>]" }; }
      const team = (flags["--team"] as string | undefined) || resolveTeamFromContext();
      cmdTeamTaskAssign(team, id, agent);

    } else if (sub === "status") {
      // maw team status [team-name]
      const { cmdTeamStatus } = await import("./team-status");
      await cmdTeamStatus(args[1]);

    } else if (sub === "delete" || sub === "rm") {
      // maw team delete <team-name>
      const { cmdTeamDelete } = await import("./team-cleanup");
      if (!args[1]) { return { ok: false, error: "usage: maw team delete <team-name>" }; }
      await cmdTeamDelete(args[1]);

    } else if (sub === "invite") {
      // maw team invite <team> <peer> [--scope <scope>] [--lead <lead>]
      const { cmdTeamInvite } = await import("./team-invite");
      const flags = parseFlags(args, {
        "--scope": String,
        "--lead": String,
      }, 1);
      const team = flags._[0];
      const peer = flags._[1];
      if (!team || !peer) {
        logs.push("usage: maw team invite <team> <peer> [--scope <scope>] [--lead <lead>]");
        return { ok: false, error: "team and peer required", output: logs.join("\n") };
      }
      await cmdTeamInvite(team, peer, {
        scope: flags["--scope"] as string | undefined,
        lead: flags["--lead"] as string | undefined,
      });

    } else {
      logs.push(`unknown team subcommand: ${sub}`);
      logs.push("usage: maw team <create|spawn|send|shutdown|resume|lives|list|status|add|tasks|done|assign|delete|invite>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
