import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadTeam, writeMessage, resolvePsi } from "./team-helpers";
import { loadOracleRegistry } from "./oracle-members";

export type TeamSendMode =
  | { mode: "broadcast"; message: string }
  | { mode: "single"; agent: string; message: string };

export function teamMessageTargets(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  const oracleTargets = registry?.members.map(m => m.oracle).filter(Boolean) ?? [];
  const liveTeam = loadTeam(teamName);
  const liveTargets = liveTeam?.members
    .filter(m => m.agentType !== "team-lead")
    .map(m => m.name) ?? [];
  return [...new Set([...oracleTargets, ...liveTargets])];
}

export function resolveTeamSendMode(args: string[], knownTargets: string[]): TeamSendMode {
  if (args.length === 0) throw new Error("usage: maw team send <team> <message>");
  if (args.length === 1) return { mode: "broadcast", message: args[0]! };

  const first = args[0]!;
  const tail = args.slice(1).join(" ");
  // Preserve the legacy single-agent form when the candidate is a known team
  // member, or when no membership registry exists and the command would have
  // historically fallen back to an async mailbox write.
  if (knownTargets.length === 0 || knownTargets.includes(first)) {
    return { mode: "single", agent: first, message: tail };
  }

  // Otherwise, treat all remaining argv as an unquoted broadcast message:
  // `maw team send myteam hello team` should not require shell quotes.
  return { mode: "broadcast", message: args.join(" ") };
}

// ─── maw team send <team> <agent> <message> ───

export function cmdTeamSend(teamName: string, agent: string, message: string) {
  if (!message) {
    throw new Error("usage: maw team send <team> <agent> <message>");
  }

  // Try CC team inbox first (live team), fallback to vault mailbox
  const team = loadTeam(teamName);
  if (team) {
    writeMessage(teamName, agent, "maw-team-send", message);
    console.log(`\x1b[32m✓\x1b[0m message sent to ${agent} in live team '${teamName}'`);
    return;
  }

  // Fallback: write to ψ mailbox for async delivery
  const PSI = resolvePsi();
  const mailboxDir = join(PSI, "memory", "mailbox", agent);
  mkdirSync(mailboxDir, { recursive: true });
  const msgFile = join(mailboxDir, `msg-${Date.now()}.json`);
  writeFileSync(msgFile, JSON.stringify({
    from: "maw-team-send",
    team: teamName,
    text: message,
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`\x1b[32m✓\x1b[0m message written to ψ/memory/mailbox/${agent}/ (team not live)`);
}


// ─── maw team send <team> <message> (#1616 broadcast mode) ───

export async function cmdTeamBroadcast(teamName: string, message: string) {
  if (!message) {
    throw new Error("usage: maw team send <team> <message>");
  }

  const targets = teamMessageTargets(teamName);
  if (targets.length === 0) {
    throw new Error(`no members in team '${teamName}' — run: maw team oracle-invite <oracle> --team ${teamName}`);
  }

  console.log(`\x1b[36m⚡\x1b[0m broadcast to ${targets.length} member(s) in team '${teamName}':`);
  let delivered = 0;
  let failed = 0;
  const { cmdSend } = await import("maw-js/commands/shared/comm-send");
  const origExit = process.exit;
  try {
    for (const target of targets) {
      let exited = false;
      process.exit = ((code?: number) => {
        exited = true;
        throw new Error(`send exited${code === undefined ? "" : ` with ${code}`}`);
      }) as never;
      try {
        await cmdSend(target, message, false);
        if (exited) failed++;
        else delivered++;
      } catch (e: any) {
        failed++;
        console.error(`  \x1b[31m✗\x1b[0m ${target}: ${e?.message || "failed"}`);
      }
    }
  } finally {
    process.exit = origExit;
  }

  if (failed > 0) {
    throw new Error(`broadcast partial failure: ${delivered} delivered, ${failed} failed`);
  }
  console.log(`\x1b[32m✓\x1b[0m broadcast delivered to ${delivered} member(s)`);
}
