import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadTeam, writeMessage, resolvePsi } from "./team-helpers";

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
