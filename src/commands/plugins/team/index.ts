import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  cmdTeamShutdown, cmdTeamList, cmdTeamCreate, cmdTeamSpawn,
  cmdTeamSend, cmdTeamResume, cmdTeamLives,
} from "./impl";
import { parseFlags } from "../../../cli/parse-args";
import { hostExec } from "../../../sdk";

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

  // #1020 — detect team from tmux session name (strip NN- prefix)
  if (process.env.TMUX) {
    try {
      const { execSync } = require("child_process");
      const sessionName = execSync("tmux display-message -p '#{session_name}'", { encoding: "utf-8" }).trim();
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

    } else if (sub === "split" || sub === "open") {
      // maw team open <target> [--pct N] [--vertical]
      const { cmdSplit } = await import("../split/impl");
      const flags = parseFlags(args, {
        "--pct": Number,
        "--vertical": Boolean,
      }, 1);
      const target = flags._[0];
      if (!target) {
        logs.push("usage: maw team open <session|agent> [--pct N] [--vertical]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await cmdSplit(target, {
        pct: flags["--pct"] as number | undefined,
        vertical: !!flags["--vertical"],
        lock: true,
      });

    } else if (sub === "close") {
      if (!process.env.TMUX) {
        logs.push("\x1b[33m⚠\x1b[0m close requires tmux");
        return { ok: false, error: "not in tmux" };
      }
      const myPane = process.env.TMUX_PANE;
      const paneList = (await hostExec("tmux list-panes -F '#{pane_id}'")).split("\n").filter(Boolean);
      if (paneList.length <= 1) {
        console.log("\x1b[90mno split panes to close\x1b[0m");
        return { ok: true };
      }
      let killed = 0;
      for (const pane of paneList) {
        if (pane === myPane) continue;
        try { await hostExec(`tmux kill-pane -t '${pane}'`); killed++; } catch {}
      }
      console.log(`\x1b[32m✓\x1b[0m closed ${killed} pane${killed !== 1 ? "s" : ""}`);


    } else if (sub === "peek") {
      // maw team peek <target>
      const { cmdTmuxPeek } = await import("../tmux/impl");
      const target = args[1];
      if (!target) {
        logs.push("usage: maw team peek <session|agent>");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      await cmdTmuxPeek(target);

    } else if (sub === "prep") {
      // maw team prep <N> [--tiled]
      if (!process.env.TMUX) {
        logs.push("\x1b[33m⚠\x1b[0m prep requires tmux");
        return { ok: false, error: "not in tmux" };
      }
      const count = parseInt(args[1] || "0");
      if (!count || count < 1 || count > 10) {
        logs.push("usage: maw team prep <1-10> [--tiled]");
        return { ok: false, error: "count required (1-10)" };
      }
      const tiled = args.includes("--tiled");
      const {
        nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
        applyTeamLayout, applyTiledLayout, getWindowTarget,
      } = await import("../tmux/layout-manager");
      const { hostExec, withPaneLock } = await import("../../../sdk");
      const { TEAMS_DIR, loadTeam } = await import("./team-helpers");
      const { readFileSync, writeFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      const anchor = process.env.TMUX_PANE ?? "";

      const teamName = resolveTeamFromContext();
      const teamConfigPath = join(TEAMS_DIR, teamName, "config.json");

      for (let i = 0; i < count; i++) {
        const name = `agent-${i + 1}`;
        const color = nextAgentColor(i);
        const agentId = `${name}@${teamName}`;
        const targetFlag = anchor ? `-t '${anchor}' ` : "";

        let paneId = "";
        await withPaneLock(async () => {
          paneId = (await hostExec(
            `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' 'echo "\\x1b[${colorAnsi(color)}m${name} ready\\x1b[0m" && exec zsh'`,
          )).trim();
          await new Promise(r => setTimeout(r, 200));
        });
        await stylePaneBorder(paneId, name, color);

        // Upsert in team config
        if (existsSync(teamConfigPath)) {
          try {
            const cfg = JSON.parse(readFileSync(teamConfigPath, "utf-8"));
            const existing = cfg.members.findIndex((m: any) => m.name === name);
            const entry = { name, agentId, tmuxPaneId: paneId, color, model: "shell" };
            if (existing >= 0) cfg.members[existing] = entry;
            else cfg.members.push(entry);
            writeFileSync(teamConfigPath, JSON.stringify(cfg, null, 2));
          } catch { /* best effort */ }
        }

        const window = await getWindowTarget();
        if (tiled) {
          await applyTiledLayout(window);
        } else if (anchor) {
          await applyTeamLayout(window, anchor);
        }
        await enableBorderStatus(window);
        console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${agentId} → ${paneId}`);
      }
      console.log(`\x1b[32m✓\x1b[0m ${count} panes ready (${tiled ? "tiled" : "main-vertical"}, team: ${teamName})`);

    } else if (sub === "broadcast" || sub === "shout") {
      // maw team broadcast <message> — send keystrokes to ALL agent panes
      const message = args.slice(1).join(" ");
      if (!message) {
        logs.push("usage: maw team broadcast <message>");
        return { ok: false, error: "message required", output: logs.join("\n") };
      }
      const teamName = resolveTeamFromContext();
      const { loadTeam } = await import("./team-helpers");
      const team = loadTeam(teamName);
      if (!team) {
        logs.push(`\x1b[33m⚠\x1b[0m team '${teamName}' not found`);
        return { ok: false, error: "team not found" };
      }
      const { hostExec: exec } = await import("../../../sdk");
      const { colorAnsi } = await import("../tmux/layout-manager");
      const withPanes = team.members.filter(m => m.tmuxPaneId && m.agentType !== "team-lead");
      let sent = 0;
      for (const m of withPanes) {
        try {
          await exec(`tmux send-keys -t '${m.tmuxPaneId}' '${message.replace(/'/g, "'\\''")}' Enter`);
          const color = (m.color || "white") as any;
          console.log(`  \x1b[${colorAnsi(color)}m→\x1b[0m ${m.agentId || m.name}`);
          sent++;
        } catch { /* pane may be dead */ }
      }
      console.log(`\x1b[32m✓\x1b[0m broadcast to ${sent}/${withPanes.length} agents: ${message}`);

    } else if (sub === "hey") {
      // maw team hey <agent> <message> — send keystrokes to agent's tmux pane
      const agent = args[1];
      const message = args.slice(2).join(" ");
      if (!agent || !message) {
        logs.push("usage: maw team hey <agent> <message>");
        return { ok: false, error: "agent and message required", output: logs.join("\n") };
      }
      const teamName = resolveTeamFromContext();
      const { TEAMS_DIR, loadTeam } = await import("./team-helpers");
      const team = loadTeam(teamName);
      if (!team) {
        logs.push(`\x1b[33m⚠\x1b[0m team '${teamName}' not found`);
        return { ok: false, error: "team not found" };
      }
      // Find agent by name or agentId (strip @team suffix for matching)
      const member = team.members.find(m =>
        m.name === agent || m.agentId === agent || m.agentId === `${agent}@${teamName}`
      );
      if (!member || !member.tmuxPaneId) {
        logs.push(`\x1b[33m⚠\x1b[0m agent '${agent}' not found or no pane ID`);
        logs.push(`Available: ${team.members.filter(m => m.tmuxPaneId).map(m => m.name).join(", ") || "none"}`);
        return { ok: false, error: "agent not found" };
      }
      const { hostExec: exec } = await import("../../../sdk");
      await exec(`tmux send-keys -t '${member.tmuxPaneId}' '${message.replace(/'/g, "'\\''")}' Enter`);
      const { colorAnsi } = await import("../tmux/layout-manager");
      const color = (member.color || "white") as any;
      console.log(`\x1b[${colorAnsi(color)}m→\x1b[0m sent to ${member.agentId || member.name}: ${message}`);

    } else if (sub === "layout") {
      // maw team layout [main-vertical|tiled] [--pct N]
      if (!process.env.TMUX) {
        logs.push("\x1b[33m⚠\x1b[0m layout requires tmux");
        return { ok: false, error: "not in tmux" };
      }
      const { applyTeamLayout, applyTiledLayout, getWindowTarget } = await import("../tmux/layout-manager");
      const preset = args[1] || "main-vertical";
      const window = await getWindowTarget();
      const anchor = process.env.TMUX_PANE ?? "";
      if (preset === "tiled") {
        await applyTiledLayout(window);
        console.log(`\x1b[32m✓\x1b[0m applied tiled layout`);
      } else {
        const pctIdx = args.indexOf("--pct");
        const pct = pctIdx !== -1 ? parseInt(args[pctIdx + 1] || "30") : 30;
        await applyTeamLayout(window, anchor, pct);
        console.log(`\x1b[32m✓\x1b[0m applied main-vertical layout (leader ${pct}%)`);
      }

    } else if (sub === "inbox") {
      // maw team inbox [agent] [--mark-read]
      const { readInbox, readUnread, markRead } = await import("./inbox");
      const teamName = resolveTeamFromContext();
      const agent = args[1] || "leader";
      const doMark = args.includes("--mark-read");

      const messages = doMark ? readInbox(teamName, agent) : readUnread(teamName, agent);
      if (messages.length === 0) {
        console.log(`\x1b[90mno ${doMark ? "" : "unread "}messages for ${agent}@${teamName}\x1b[0m`);
      } else {
        const { colorAnsi } = await import("../tmux/layout-manager");
        for (const m of messages) {
          const ts = new Date(m.timestamp).toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit" });
          const typeColor = m.type === "done" ? "32" : m.type === "stuck" ? "31" : m.type === "progress" ? "36" : "33";
          const payload = Object.values(m.payload).join(" ").slice(0, 60);
          console.log(`  \x1b[${typeColor}m${m.type.padEnd(10)}\x1b[0m \x1b[90m${ts}\x1b[0m ${m.from} → ${payload}`);
        }
        console.log(`\x1b[90m  ${messages.length} message${messages.length !== 1 ? "s" : ""}\x1b[0m`);
      }
      if (doMark) {
        const marked = markRead(teamName, agent);
        if (marked > 0) console.log(`\x1b[32m✓\x1b[0m marked ${marked} message${marked !== 1 ? "s" : ""} read`);
      }

    } else if (sub === "recover") {
      // maw team recover [team-name] — restore layout from snapshot
      const { loadLayoutSnapshot } = await import("./layout-snapshot");
      const {
        stylePaneBorder, enableBorderStatus, applyTeamLayout, getWindowTarget, colorAnsi,
      } = await import("../tmux/layout-manager");
      const teamName = args[1] || resolveTeamFromContext();
      const snapshot = loadLayoutSnapshot(teamName);
      if (!snapshot) {
        logs.push(`\x1b[33m⚠\x1b[0m no layout snapshot for team '${teamName}'`);
        return { ok: false, error: "no snapshot" };
      }

      const alive = await (async () => {
        try {
          const out = await hostExec("tmux list-panes -a -F '#{pane_id}'");
          return new Set(out.split("\n").filter(Boolean));
        } catch { return new Set<string>(); }
      })();

      let recovered = 0;
      let dead = 0;
      for (const p of snapshot.panes) {
        if (alive.has(p.tmuxPaneId)) {
          await stylePaneBorder(p.tmuxPaneId, p.name, p.color);
          recovered++;
          console.log(`  \x1b[${colorAnsi(p.color)}m●\x1b[0m ${p.agentId} → ${p.tmuxPaneId} (alive)`);
        } else {
          dead++;
          console.log(`  \x1b[90m·\x1b[0m ${p.agentId} → ${p.tmuxPaneId} (dead)`);
        }
      }

      if (recovered > 0) {
        const window = await getWindowTarget();
        const anchor = process.env.TMUX_PANE ?? snapshot.leaderPane;
        await applyTeamLayout(window, anchor);
        await enableBorderStatus(window);
      }

      const age = Math.round((Date.now() - snapshot.savedAt) / 60000);
      console.log(`\x1b[32m✓\x1b[0m recovered ${recovered} pane${recovered !== 1 ? "s" : ""}, ${dead} dead (snapshot ${age}m ago)`);

    } else {
      logs.push(`unknown team subcommand: ${sub}`);
      logs.push("usage: maw team <create|spawn|send|shutdown|split|peek|hey|inbox|layout|prep|recover|resume|lives|list|status|add|tasks|done|assign|delete>");
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
