import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { resolvePsi } from "./team-helpers";
import { cmdTeamSpawn } from "./team-lifecycle";

// ─── maw team resume <name> ───

export function cmdTeamResume(name: string, opts: { model?: string } = {}) {
  const PSI = resolvePsi();
  const manifestPath = join(PSI, "memory", "mailbox", "teams", name, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`no archived team '${name}' found — looked in: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const members: string[] = manifest.members || [];

  if (!members.length) {
    console.log(`\x1b[90mTeam '${name}' has no members to resume.\x1b[0m`);
    return;
  }

  console.log(`\x1b[36m⏳\x1b[0m resuming team '${name}' — ${members.length} agent(s)...\n`);

  for (const member of members) {
    cmdTeamSpawn(name, member, { model: opts.model });
    console.log();
  }

  console.log(`\x1b[32m✓\x1b[0m team '${name}' resumed — ${members.length} agent(s) reincarnated`);
}

// ─── maw team lives <agent> ───

export function cmdTeamLives(agent: string) {
  const PSI = resolvePsi();
  const mailboxDir = join(PSI, "memory", "mailbox", agent);

  if (!existsSync(mailboxDir)) {
    console.log(`\x1b[90mNo past lives found for '${agent}'\x1b[0m`);
    console.log(`  \x1b[90mlooked in: ${mailboxDir}\x1b[0m`);
    return;
  }

  const files = readdirSync(mailboxDir).sort();

  console.log(`\n  \x1b[36;1m${agent} — past lives\x1b[0m\n`);

  // Standing orders
  const hasOrders = files.includes("standing-orders.md");
  console.log(`  standing orders: ${hasOrders ? "\x1b[32myes\x1b[0m" : "\x1b[90mno\x1b[0m"}`);

  // Findings
  const findings = files.filter(f => f.endsWith("_findings.md"));
  if (findings.length) {
    console.log(`  findings: \x1b[32m${findings.length}\x1b[0m`);
    for (const f of findings) {
      const lines = readFileSync(join(mailboxDir, f), "utf-8").split("\n").length;
      console.log(`    \x1b[90m${f} (${lines} lines)\x1b[0m`);
    }
  } else {
    console.log(`  findings: \x1b[90mnone\x1b[0m`);
  }

  // Other files (messages, team archives)
  const other = files.filter(f => f !== "standing-orders.md" && !f.endsWith("_findings.md"));
  if (other.length) {
    console.log(`  other: \x1b[90m${other.join(", ")}\x1b[0m`);
  }

  console.log();
}
