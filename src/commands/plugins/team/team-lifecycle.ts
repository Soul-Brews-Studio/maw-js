import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { tmux } from "../../../sdk";
import { assertValidOracleName } from "../../../core/fleet/validate";
import { TEAMS_DIR, loadTeam, resolvePsi, writeShutdownRequest, cleanupTeamDir, type TeamConfig, type TeamMember } from "./team-helpers";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Copy per-member inbox + findings to the vault mailbox, then archive the
 * manifest. Extracted from cmdTeamShutdown so it can be called from both
 * the alive=0 and alive>0 paths (#393 Bug G — --merge was unreachable
 * when all members had already exited).
 *
 * Iterates `teammates` (not `alive`) so dead members' accumulated state
 * still gets captured — the whole point of --merge is to preserve state
 * at shutdown time, regardless of whether members are still live.
 */
export function mergeTeamKnowledge(name: string, teammates: Array<{ name: string }>) {
  const PSI = resolvePsi();
  const teamInboxDir = join(TEAMS_DIR, name, "inboxes");
  for (const m of teammates) {
    const dest = join(PSI, "memory", "mailbox", m.name);
    mkdirSync(dest, { recursive: true });
    // Copy inbox messages
    const src = join(teamInboxDir, `${m.name}.json`);
    if (existsSync(src)) {
      copyFileSync(src, join(dest, `team-${name}-inbox.json`));
    }
    // Copy any findings from team dir
    const memberDir = join(TEAMS_DIR, name, m.name);
    if (existsSync(memberDir)) {
      try {
        for (const f of readdirSync(memberDir).filter(f => f.endsWith("_findings.md"))) {
          copyFileSync(join(memberDir, f), join(dest, f));
        }
      } catch { /* best effort */ }
    }
    console.log(`  \x1b[36m↪\x1b[0m merged ${m.name} → ψ/memory/mailbox/${m.name}/`);
  }
  // Archive manifest instead of deleting
  const manifestSrc = join(TEAMS_DIR, name, "config.json");
  if (existsSync(manifestSrc)) {
    const archiveDest = join(PSI, "memory", "mailbox", "teams", name);
    mkdirSync(archiveDest, { recursive: true });
    copyFileSync(manifestSrc, join(archiveDest, "manifest.json"));
  }
}

// ─── maw team shutdown <name> ───

export async function cmdTeamShutdown(name: string, opts: { force?: boolean; merge?: boolean } = {}) {
  const team = loadTeam(name);
  if (!team) {
    throw new Error(`team not found: ${name} — check ~/.claude/teams/ for available teams`);
  }

  const teammates = team.members.filter(m => m.agentType !== "team-lead");
  if (!teammates.length) {
    console.log(`\x1b[90mNo teammates to shut down in '${name}'.\x1b[0m`);
    return;
  }

  const panes = await tmux.listPaneIds();
  const alive = teammates.filter(m =>
    m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)
  );

  if (!alive.length) {
    console.log(`\x1b[90mAll teammates in '${name}' already exited. Cleaning up config...\x1b[0m`);
    // #393 Bug G: --merge must still run when alive=0. Knowledge preservation
    // is the whole point; gating it on alive count caused silent data loss.
    if (opts.merge) {
      mergeTeamKnowledge(name, teammates);
    }
    cleanupTeamDir(name);
    if (opts.merge) console.log(`\x1b[32m✓\x1b[0m team '${name}' cleaned up (knowledge merged)`);
    return;
  }

  console.log(`\x1b[36m⏳\x1b[0m shutting down ${alive.length} teammate(s) in '${name}'...`);

  // Step 1: Send shutdown_request via inbox files
  for (const m of alive) {
    try {
      writeShutdownRequest(name, m.name, "team teardown via maw team shutdown");
      console.log(`  \x1b[90m↪ shutdown_request → ${m.name} (${m.tmuxPaneId})\x1b[0m`);
    } catch (e) {
      console.error(`  \x1b[31m✗\x1b[0m failed to send shutdown to ${m.name}: ${e}`);
    }
  }

  // Step 2: Wait for panes to die (up to 30s)
  const deadline = Date.now() + 30_000;
  let remaining = alive.length;
  while (Date.now() < deadline && remaining > 0) {
    await sleep(1000);
    const current = await tmux.listPaneIds();
    remaining = alive.filter(m => current.has(m.tmuxPaneId!)).length;
    if (remaining > 0 && Date.now() + 5000 > deadline) break;
  }
  // Step 3: Force-kill stragglers
  const finalPanes = await tmux.listPaneIds();
  for (const m of alive) {
    if (!finalPanes.has(m.tmuxPaneId!)) {
      console.log(`  \x1b[32m✓\x1b[0m ${m.name} shut down gracefully`);
      continue;
    }
    if (opts.force) {
      await tmux.killPane(m.tmuxPaneId!);
      console.log(`  \x1b[33m⚠\x1b[0m force-killed ${m.name} (${m.tmuxPaneId})`);
    } else {
      console.error(`  \x1b[31m✗\x1b[0m ${m.name} did not respond to shutdown_request (use --force to kill)`);
    }
  }

  // FUSION: merge team knowledge into individual oracle mailboxes
  if (opts.merge) {
    mergeTeamKnowledge(name, teammates);
  }

  cleanupTeamDir(name);
  console.log(`\x1b[32m✓\x1b[0m team '${name}' shut down${opts.merge ? " (knowledge merged)" : ""}`);
}

// ─── maw team create <name> ───
export function cmdTeamCreate(name: string, opts: { description?: string } = {}) {
  assertValidOracleName(name);

  const PSI = resolvePsi();
  const teamDir = join(PSI, "memory", "mailbox", "teams", name);

  if (existsSync(join(teamDir, "manifest.json"))) {
    throw new Error(`team '${name}' already exists at ${teamDir}`);
  }

  mkdirSync(teamDir, { recursive: true });

  const manifest = {
    name,
    createdAt: Date.now(),
    members: [] as string[],
    description: opts.description || "",
  };
  writeFileSync(join(teamDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Bridge: write stub to tool store so list/status/shutdown can see this team (#393)
  const toolTeamDir = join(TEAMS_DIR, name);
  if (!existsSync(toolTeamDir)) {
    mkdirSync(toolTeamDir, { recursive: true });
    const stubConfig: TeamConfig = {
      name,
      description: opts.description || "",
      members: [],
      createdAt: Date.now(),
    };
    writeFileSync(join(toolTeamDir, "config.json"), JSON.stringify(stubConfig, null, 2));
  }

  console.log(`\x1b[32m✓\x1b[0m team '${name}' created`);
  console.log(`  \x1b[90m${teamDir}/manifest.json\x1b[0m`);
}

// ─── maw team spawn <team> <role> ───
export async function cmdTeamSpawn(
  teamName: string,
  role: string,
  opts: { model?: string; prompt?: string; exec?: boolean } = {},
) {
  const PSI = resolvePsi();
  const teamDir = join(PSI, "memory", "mailbox", "teams", teamName);
  const manifestPath = join(teamDir, "manifest.json");

  if (!existsSync(manifestPath)) {
    throw new Error(`team '${teamName}' not found — run: maw team create ${teamName}`);
  }

  // Check for past life
  const agentMailbox = join(PSI, "memory", "mailbox", role);
  let pastLife = false;
  let standingOrders = "";
  let latestFindings = "";

  if (existsSync(agentMailbox)) {
    pastLife = true;
    const soPath = join(agentMailbox, "standing-orders.md");
    if (existsSync(soPath)) {
      standingOrders = readFileSync(soPath, "utf-8");
    }
    // Find latest *_findings.md
    try {
      const findings = readdirSync(agentMailbox)
        .filter(f => f.endsWith("_findings.md"))
        .sort()
        .pop();
      if (findings) {
        const lines = readFileSync(join(agentMailbox, findings), "utf-8").split("\n");
        latestFindings = lines.slice(-30).join("\n");
      }
    } catch { /* no findings */ }
  }

  // Build spawn prompt
  const model = opts.model || "sonnet";
  const parts: string[] = [];
  parts.push(`You are '${role}' on team '${teamName}'.`);
  if (opts.prompt) parts.push(opts.prompt);
  if (standingOrders) parts.push(`## Standing Orders (from past life)\n${standingOrders}`);
  if (latestFindings) parts.push(`## Last Known Findings\n${latestFindings}`);

  const spawnPrompt = parts.join("\n\n");

  // Write prompt file for the user to use
  const promptPath = join(teamDir, `${role}-spawn-prompt.md`);
  writeFileSync(promptPath, spawnPrompt);

  // Update manifest with new member
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.members.includes(role)) {
    manifest.members.push(role);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Bridge: sync member to tool store config (#393)
  const toolConfigPath = join(TEAMS_DIR, teamName, "config.json");
  if (existsSync(toolConfigPath)) {
    try {
      const toolConfig = JSON.parse(readFileSync(toolConfigPath, "utf-8"));
      const member: TeamMember = { name: role, model };
      if (!toolConfig.members.some((m: any) => m.name === role)) {
        toolConfig.members.push(member);
        writeFileSync(toolConfigPath, JSON.stringify(toolConfig, null, 2));
      }
    } catch { /* best effort */ }
  }

  console.log(`\x1b[32m✓\x1b[0m spawn prompt written for '${role}'`);
  console.log(`  \x1b[90mpast life: ${pastLife ? "yes" : "no"}\x1b[0m`);
  console.log(`  \x1b[90mmodel: ${model}\x1b[0m`);
  console.log(`  \x1b[90mprompt: ${promptPath}\x1b[0m`);

  // #393 Bug C — opt-in auto-spawn via splitWindowLocked. Default behavior
  // (print-only) is unchanged. With --exec, we split the current pane and
  // run the printed claude command inside it. Requires $TMUX (must be
  // inside an active tmux session).
  if (opts.exec) {
    if (!process.env.TMUX) {
      console.log();
      console.log(`  \x1b[33m⚠\x1b[0m --exec requires an active tmux session ($TMUX not set).`);
      console.log(`  \x1b[36mRun manually:\x1b[0m claude --model ${model} --prompt-file "${promptPath}"`);
      return;
    }
    try {
      const { hostExec } = await import("../../../sdk");
      const claudeCmd = `claude --model ${model} --prompt-file '${promptPath.replace(/'/g, "'\\''")}'`;
      await hostExec(`tmux split-window -h -l 50% '${claudeCmd.replace(/'/g, "'\\''")}'`);
      console.log();
      console.log(`  \x1b[32m✓ --exec\x1b[0m spawned ${role} in a new tmux pane (right, 50%)`);
    } catch (e: any) {
      console.log();
      console.log(`  \x1b[33m⚠\x1b[0m --exec split failed: ${e?.message || e}`);
      console.log(`  \x1b[36mRun manually:\x1b[0m claude --model ${model} --prompt-file "${promptPath}"`);
    }
    return;
  }

  console.log();
  console.log(`  \x1b[36mRun:\x1b[0m claude --model ${model} --prompt-file "${promptPath}"`);
}
