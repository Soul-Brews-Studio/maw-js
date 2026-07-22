import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { tmux, isAgentCommand, loadOracleRegistry, loadFleetEntries } from "maw-js/sdk";

export interface BroadcastScopeOptions {
  session?: string;
  team?: string;
  fleet?: string;
}

export interface BroadcastCommand {
  message: string;
  scope: BroadcastScopeOptions;
  /** kobo-368 — compact-ack sweep: --verbose/--full reproduce the pre-368 per-window echo. */
  verbose: boolean;
}

function usage(): string {
  return "usage: maw broadcast <message> [--session <name>] [--team <name>] [--fleet <name>] [--verbose|--full]";
}

export function parseBroadcastArgs(args: string[]): BroadcastCommand {
  const scope: BroadcastScopeOptions = {};
  const messageParts: string[] = [];
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--session" || arg === "--team" || arg === "--fleet") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value\n${usage()}`);
      if (arg === "--session") scope.session = value;
      else if (arg === "--team") scope.team = value;
      else scope.fleet = value;
      continue;
    }
    if (arg === "--verbose" || arg === "--full") { verbose = true; continue; }
    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();
  if (!message) throw new Error(usage());
  return { message, scope, verbose };
}

function stripNumericPrefix(value: string): string {
  return value.replace(/^\d+-/, "");
}

function stripOracleSuffix(value: string): string {
  return value.replace(/-oracle$/i, "");
}

function normalizedNames(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const strippedPrefix = stripNumericPrefix(trimmed);
  return [...new Set([
    trimmed,
    strippedPrefix,
    stripOracleSuffix(trimmed),
    stripOracleSuffix(strippedPrefix),
    `${strippedPrefix}-oracle`,
  ].filter(Boolean))];
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

function teamConfigMemberNames(teamName: string): string[] {
  const cfg = readJson(join(homedir(), ".claude", "teams", teamName, "config.json"));
  if (!cfg || !Array.isArray(cfg.members)) return [];
  return cfg.members
    .filter((m: any) => m?.agentType !== "team-lead" && m?.role !== "lead" && m?.name !== "team-lead")
    .map((m: any) => typeof m?.name === "string" ? m.name : "")
    .filter(Boolean);
}

function resolvePsi(): string {
  let dir = process.cwd();
  while (true) {
    const psi = join(dir, "ψ");
    if (existsSync(psi) && existsSync(join(dir, "CLAUDE.md"))) return psi;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "ψ");
}

function teamManifestMemberNames(teamName: string): string[] {
  const manifest = readJson(join(resolvePsi(), "memory", "mailbox", "teams", teamName, "manifest.json"));
  if (!manifest) return [];
  const out: string[] = [];
  for (const entry of Array.isArray(manifest.members) ? manifest.members : []) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry.name === "string") out.push(entry.name);
  }
  for (const entry of Array.isArray(manifest.charter?.members) ? manifest.charter.members : []) {
    if (entry && typeof entry.name === "string") out.push(entry.name);
    else if (entry && typeof entry.role === "string") out.push(entry.role);
  }
  return out;
}

export function teamScopeMemberNames(teamName: string): string[] {
  const registry = loadOracleRegistry(teamName);
  const registryMembers = registry?.members.map(m => m.oracle).filter(Boolean) ?? [];
  return [...new Set([
    ...registryMembers,
    ...teamConfigMemberNames(teamName),
    ...teamManifestMemberNames(teamName),
  ])];
}

export function fleetScopeSessionNames(fleetName: string): Set<string> {
  const wanted = new Set(normalizedNames(fleetName));
  const sessions = new Set<string>();
  for (const entry of loadFleetEntries()) {
    const candidates = [
      entry.groupName,
      entry.file.replace(/\.json$/i, ""),
      entry.session.name,
      stripNumericPrefix(entry.session.name),
    ];
    if (candidates.some(c => wanted.has(c))) sessions.add(entry.session.name);
  }
  return sessions;
}

function windowMatchesTeamMember(sessionName: string, windowName: string, teamMembers: Set<string>): boolean {
  return [...normalizedNames(sessionName), ...normalizedNames(windowName)].some(name => teamMembers.has(name));
}

function scopeDescription(scope: BroadcastScopeOptions): string {
  const parts = [
    scope.session ? `session=${scope.session}` : "",
    scope.team ? `team=${scope.team}` : "",
    scope.fleet ? `fleet=${scope.fleet}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "all agents";
}

/**
 * maw broadcast <message> — send to agent windows, optionally scoped by
 * --session, --team charter members, and/or --fleet tagged session.
 * Always prefixes with sender identity so receivers know who broadcasted.
 *
 * #1881 — uses shared isAgentCommand (not hardcoded "claude" substring) so
 * panes running thclaws / codex / configured engines are reached. Emits a
 * skip-reason breakdown when at least one window is skipped, so 0-windows
 * surprises become diagnosable.
 */
export async function cmdBroadcast(message: string, scope: BroadcastScopeOptions = {}, verbose = false) {
  if (!message) {
    throw new Error(usage());
  }

  // Detect sender from current tmux window
  let sender = "unknown";
  try {
    sender = await tmux.run("display-message", "-p", "#{window_name}");
    sender = sender.trim() || "unknown";
  } catch { /* expected: may not be in tmux */ }

  // Prefix message with sender
  message = `[broadcast from ${sender}] ${message}`;

  const sessions = await tmux.listAll();
  const teamMembers = scope.team ? new Set(teamScopeMemberNames(scope.team).flatMap(normalizedNames)) : null;
  const fleetSessions = scope.fleet ? fleetScopeSessionNames(scope.fleet) : null;
  let sent = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  for (const s of sessions) {
    // Skip overview/scratch/view sessions
    if (s.name === "99-overview" || s.name === "scratch") continue;
    if (s.name.endsWith("-view")) continue;
    if (scope.session && s.name !== scope.session) continue;
    if (fleetSessions && !fleetSessions.has(s.name)) continue;

    for (const w of s.windows) {
      if (teamMembers && !windowMatchesTeamMember(s.name, w.name, teamMembers)) continue;
      const target = `${s.name}:${w.index}`;
      try {
        // Check if window is running an agent (shared with ssh.ts post-#1906)
        const cmd = await tmux.run("display-message", "-t", target, "-p", "#{pane_current_command}");
        if (!isAgentCommand(cmd)) {
          skipped++;
          skipReasons.set("non-agent-pane", (skipReasons.get("non-agent-pane") ?? 0) + 1);
          continue;
        }
        await tmux.sendText(target, message);
        if (verbose) console.log(`\x1b[32msent\x1b[0m → ${s.name}:${w.name}`);
        sent++;
      } catch {
        skipped++;
        skipReasons.set("exception", (skipReasons.get("exception") ?? 0) + 1);
      }
    }
  }

  console.log(`\n\x1b[32m✓\x1b[0m Broadcast to ${sent} windows (${skipped} skipped) [scope: ${scopeDescription(scope)}]`);
  if (skipped > 0) {
    console.log(`  \x1b[90mskipped breakdown:\x1b[0m`);
    for (const [reason, count] of skipReasons) {
      console.log(`    \x1b[90m${reason}: ${count}\x1b[0m`);
    }
  }
}
