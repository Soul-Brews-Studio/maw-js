import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  cmdTeamShutdown, cmdTeamList, cmdTeamCreate, cmdTeamSpawn,
  cmdTeamSend, cmdTeamResume, cmdTeamLives,
} from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";
import { hostExec } from "maw-js/sdk";

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

  if (process.env.TMUX) {
    try {
      const sessionName = Bun.spawnSync({
        cmd: ["tmux", "display-message", "-p", "#{session_name}"],
        stdout: "pipe",
        stderr: "pipe",
      }).stdout.toString().trim();
      const teamName = sessionName.replace(/^\d+-/, "");
      const teamsDir = join(homedir(), ".claude/teams");
      if (teamName && existsSync(join(teamsDir, teamName, "config.json"))) {
        return teamName;
      }
    } catch { /* not in tmux or tmux failed */ }
  }

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
    } else if (sub === "plan") {
      if (!args[1]) {
        logs.push("usage: maw team plan <team.yaml|team.json>");
        return { ok: false, error: "charter path required", output: logs.join("\n") };
      }
      const { readTeamCharter, planTeamCharter, formatTeamCharterPlan } = await import("./team-charter");
      logs.push(formatTeamCharterPlan(planTeamCharter(readTeamCharter(args[1]))));
    } else if (sub === "load") {
      if (!args[1]) {
        logs.push("usage: maw team load <team.yaml|team.json> --no-spawn");
        return { ok: false, error: "charter path required", output: logs.join("\n") };
      }
      if (!args.includes("--no-spawn")) {
        logs.push("usage: maw team load <team.yaml|team.json> --no-spawn");
        logs.push("Phase 1 only supports materializing charter files; spawning remains a separate future step.");
        return { ok: false, error: "--no-spawn required", output: logs.join("\n") };
      }
      const { readTeamCharter, loadTeamCharter, formatTeamCharterLoad } = await import("./team-charter");
      logs.push(formatTeamCharterLoad(loadTeamCharter(readTeamCharter(args[1]), { noSpawn: true })));
    } else if (sub === "spawn") {
      if (!args[1] || !args[2]) {
        logs.push("usage: maw team spawn <team> <role> [--model <model>] [--cwd <path>] [--worktree <path>] [--prompt <text>] [--exec]");
        return { ok: false, error: "team and role required", output: logs.join("\n") };
      }
      const modelIdx = args.indexOf("--model");
      const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
      const cwdIdx = args.indexOf("--cwd");
      const worktreeIdx = args.indexOf("--worktree");
      const cwd = cwdIdx !== -1 ? args[cwdIdx + 1] : (worktreeIdx !== -1 ? args[worktreeIdx + 1] : undefined);
      const promptIdx = args.indexOf("--prompt");
      const exec = args.includes("--exec");
      // --prompt is greedy to end-of-argv; strip known flags if they appear in the tail.
      let prompt: string | undefined;
      if (promptIdx !== -1) {
        const rawTail = args.slice(promptIdx + 1);
        const tail: string[] = [];
        for (let i = 0; i < rawTail.length; i++) {
          const a = rawTail[i];
          if (a === "--exec") continue;
          if (a === "--model" || a === "--cwd" || a === "--worktree") {
            i++;
            continue;
          }
          tail.push(a);
        }
        prompt = tail.join(" ") || undefined;
      }
      await cmdTeamSpawn(args[1], args[2], { model, prompt, exec, cwd });
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

    } else if (sub === "oracle-invite") {
      // maw team oracle-invite <oracle-name> [--team <team>] [--role <role>]
      const { cmdOracleInvite } = await import("./oracle-members");
      const flags = parseFlags(args, {
        "--team": String,
        "--role": String,
      }, 1);
      const oracleName = flags._[0];
      if (!oracleName) {
        logs.push("usage: maw team oracle-invite <oracle-name> [--team <team>] [--role <role>]");
        return { ok: false, error: "oracle name required", output: logs.join("\n") };
      }
      const team = (flags["--team"] as string | undefined) || resolveTeamFromContext();
      const role = flags["--role"] as string | undefined;
      cmdOracleInvite(team, oracleName, { role });

    } else if (sub === "oracle-remove") {
      // maw team oracle-remove <oracle-name> [--team <team>]
      const { cmdOracleRemove } = await import("./oracle-members");
      const flags = parseFlags(args, { "--team": String }, 1);
      const oracleName = flags._[0];
      if (!oracleName) {
        logs.push("usage: maw team oracle-remove <oracle-name> [--team <team>]");
        return { ok: false, error: "oracle name required", output: logs.join("\n") };
      }
      const team = (flags["--team"] as string | undefined) || resolveTeamFromContext();
      cmdOracleRemove(team, oracleName);

    } else if (sub === "members") {
      // maw team members [--team <team>]
      const { cmdOracleMembers } = await import("./oracle-members");
      const flags = parseFlags(args, { "--team": String }, 1);
      const team = (flags["--team"] as string | undefined)
        || flags._[0]
        || resolveTeamFromContext();
      cmdOracleMembers(team);

    } else if (sub === "enter" || sub === "send-enter") {
      // maw team enter <agent|all> — submit pending input in agent pane(s)
      const agent = args[1];
      if (!agent) {
        logs.push("usage: maw team enter <agent|all>");
        return { ok: false, error: "agent required", output: logs.join("\n") };
      }
      const teamName = resolveTeamFromContext();
      const { loadTeam } = await import("./team-helpers");
      const team = loadTeam(teamName);
      if (!team) {
        logs.push(`\x1b[33m⚠\x1b[0m team '${teamName}' not found`);
        return { ok: false, error: "team not found", output: logs.join("\n") };
      }
      const members = team.members.filter(m =>
        m.tmuxPaneId && m.agentType !== "team-lead" &&
        (agent === "all" || m.name === agent || m.agentId === agent || m.agentId === `${agent}@${teamName}`)
      );
      if (!members.length) {
        logs.push(`\x1b[33m⚠\x1b[0m agent '${agent}' not found or no pane ID`);
        logs.push(`Available: ${team.members.filter(m => m.tmuxPaneId).map(m => m.name).join(", ") || "none"}`);
        return { ok: false, error: "agent not found", output: logs.join("\n") };
      }
      for (const m of members) {
        await hostExec(`tmux send-keys -t '${m.tmuxPaneId}' Enter`);
        console.log(`\x1b[36m↵\x1b[0m enter sent to ${m.agentId || m.name}`);
      }

    } else {
      logs.push(`unknown team subcommand: ${sub}`);
      logs.push("usage: maw team <create|plan|load|spawn|send|shutdown|resume|lives|list|status|add|tasks|done|assign|delete|invite|oracle-invite|oracle-remove|members|enter>");
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
