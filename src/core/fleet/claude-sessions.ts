/**
 * Claude Code desktop-app session discovery.
 *
 * Finds every live/recent Claude Code session the node can see, regardless of
 * whether it was spawned via `maw wake`, a tmux pane, or directly as the macOS
 * app. Correlates:
 *   - running processes (ps)
 *   - their working directory (lsof cwd)
 *   - ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl session files
 *   - git worktree / remote → repo + branch
 *   - parent-pid chain → trigger classification
 *
 * Verified 2026-04-22 against 3 live sessions on dev01.
 */
import { readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../transport/ssh";
import { headFirstUser, tailLatestAssistant, tailLatestUser } from "./claude-transcript";

export type ClaudeTrigger = "maw-wake" | "tmux" | "desktop" | "shell" | "unknown";
export type ClaudeStatus = "active" | "idle" | "ended";

export interface ClaudeSession {
  sessionId: string;
  projectDir: string;
  cwd: string | null;
  repo: string | null;
  worktree: { name: string; branch: string } | null;
  pid: number | null;
  ppid: number | null;
  parentChain: string[];
  triggeredFrom: ClaudeTrigger;
  status: ClaudeStatus;
  lastActivityAt: string;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  role: string | null;
  sizeBytes: number;
  jsonlPath: string;
}

// Matches role declared in opening prompt, e.g. `ในฐานะ tester …` or `#role: tester`.
// Kept explicit — fuzzier patterns like "as a X" produce false positives.
const ROLE_RE = /ในฐานะ\s*["']?([A-Za-z][A-Za-z0-9_-]*)["']?|#role\s*:\s*([A-Za-z][A-Za-z0-9_-]*)/;

export function extractRole(firstUserMessage: string | null): string | null {
  if (!firstUserMessage) return null;
  const m = firstUserMessage.match(ROLE_RE);
  return m?.[1] ?? m?.[2] ?? null;
}

export type Exec = (cmd: string) => Promise<string>;

export interface DiscoveryOptions {
  exec?: Exec;
  projectsDir?: string;
  now?: () => number;
  recentWindowMs?: number;
  noCache?: boolean;
}

const DEFAULT_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_TTL_MS = 1500;
const ACTIVE_WINDOW_MS = 60_000;
const DEFAULT_RECENT_MS = 60 * 60 * 1000;
// Claude Code can run as macOS desktop binary OR standalone CLI (installed via
// `bun install -g @anthropic-ai/claude-code` / `brew install claude` / etc).
// Watcher/maw-wake sessions almost always use the CLI flavour inside tmux.
const CLAUDE_APP_RE = /Library\/Application Support\/Claude\/claude-code\/.*\/claude\.app\/Contents\/MacOS\/claude/;

let _cache: { ts: number; data: ClaudeSession[] } | null = null;

export function invalidateCache() { _cache = null; }

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export async function listClaudeSessions(opts: DiscoveryOptions = {}): Promise<ClaudeSession[]> {
  const now = (opts.now || Date.now)();
  const useCache = !opts.exec && !opts.projectsDir && !opts.noCache;
  if (useCache && _cache && now - _cache.ts < CACHE_TTL_MS) return _cache.data;

  const exec = opts.exec || hostExec;
  const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
  const recentMs = opts.recentWindowMs ?? DEFAULT_RECENT_MS;

  const pids = await listClaudePids(exec);
  const pidInfo = await Promise.all(pids.map(async p => ({
    ...p,
    cwd: await pidCwd(p.pid, exec),
  })));
  const pidByEncoded = new Map<string, typeof pidInfo[0]>();
  for (const p of pidInfo) if (p.cwd) pidByEncoded.set(encodeCwd(p.cwd), p);

  const projectDirs = await safeReaddir(projectsDir);
  const sessions: ClaudeSession[] = [];

  for (const pdir of projectDirs) {
    const latest = await newestJsonl(join(projectsDir, pdir));
    if (!latest) continue;
    const ageMs = now - latest.mtimeMs;
    const live = pidByEncoded.get(pdir);
    if (!live && ageMs > recentMs) continue;

    const status: ClaudeStatus = live
      ? (ageMs < ACTIVE_WINDOW_MS ? "active" : "idle")
      : "ended";

    const cwd = live?.cwd ?? null;
    const chain = live ? await parentChain(live.ppid, exec, 6) : [];
    const trigger = classifyTrigger(chain);
    const repoInfo = cwd ? await resolveRepoAndWorktree(cwd, exec) : null;

    const [lastUser, lastAssistant, firstUser] = await Promise.all([
      tailLatestUser(latest.path),
      tailLatestAssistant(latest.path),
      headFirstUser(latest.path),
    ]);
    const role = extractRole(firstUser);

    sessions.push({
      sessionId: latest.sessionId,
      projectDir: pdir,
      cwd,
      repo: repoInfo?.repo ?? null,
      worktree: repoInfo?.worktree ?? null,
      pid: live?.pid ?? null,
      ppid: live?.ppid ?? null,
      parentChain: chain,
      triggeredFrom: trigger,
      status,
      lastActivityAt: new Date(latest.mtimeMs).toISOString(),
      lastUserMessage: lastUser,
      lastAssistantMessage: lastAssistant,
      role,
      sizeBytes: latest.size,
      jsonlPath: latest.path,
    });
  }

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  if (useCache) _cache = { ts: now, data: sessions };
  return sessions;
}

async function safeReaddir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}

async function newestJsonl(dir: string) {
  const jsonls = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith(".jsonl"));
  if (!jsonls.length) return null;
  const stats = await Promise.all(jsonls.map(async f => {
    const p = join(dir, f);
    const s = await stat(p).catch(() => null);
    return s ? { path: p, sessionId: f.replace(/\.jsonl$/, ""), mtimeMs: s.mtimeMs, size: s.size } : null;
  }));
  const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null);
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid[0] || null;
}

export async function listClaudePids(exec: Exec): Promise<{ pid: number; ppid: number; command: string }[]> {
  const raw = await exec("ps -eo pid,ppid,command 2>/dev/null || true").catch(() => "");
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmd = m[3];
    if (!isClaudeProcess(cmd)) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: cmd });
  }
  return rows;
}

export function isClaudeProcess(cmd: string): boolean {
  if (cmd.includes("Helpers/disclaimer")) return false;
  // Desktop app flavour
  if (CLAUDE_APP_RE.test(cmd)) return true;
  // CLI flavour — first token is an executable path ending in /claude, followed
  // by a space (args) or end-of-line. Filters out shells that mention "claude"
  // in arguments (e.g. `zsh -c "grep claude"`) since their first token is /bin/zsh.
  const firstToken = cmd.split(/\s+/, 1)[0] || "";
  const basename = firstToken.split("/").pop() || "";
  if (basename === "claude") return true;
  return false;
}

export async function pidCwd(pid: number, exec: Exec): Promise<string | null> {
  const raw = await exec(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null || true`).catch(() => "");
  let last: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("n") && line.length > 1) last = line.slice(1);
  }
  return last;
}

async function parentChain(ppid: number, exec: Exec, depth: number): Promise<string[]> {
  const chain: string[] = [];
  let cur = ppid;
  while (cur > 0 && chain.length < depth) {
    const row = await exec(`ps -o ppid=,comm= -p ${cur} 2>/dev/null || true`).catch(() => "");
    const m = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) break;
    chain.push(m[2]);
    cur = Number(m[1]);
  }
  return chain;
}

export function classifyTrigger(chain: string[]): ClaudeTrigger {
  const joined = chain.join(" ").toLowerCase();
  if (/\bmaw\b/.test(joined)) return "maw-wake";
  if (/\btmux\b/.test(joined)) return "tmux";
  if (/claude\.app/.test(joined) || /\blaunchd\b/.test(joined)) return "desktop";
  if (/\b(zsh|bash|sh|fish)\b/.test(joined)) return "shell";
  return "unknown";
}

async function resolveRepoAndWorktree(cwd: string, exec: Exec): Promise<{ repo: string | null; worktree: { name: string; branch: string } | null }> {
  const esc = cwd.replace(/'/g, "'\\''");
  const [remote, branch, toplevel] = await Promise.all([
    exec(`git -C '${esc}' remote get-url origin 2>/dev/null || true`).catch(() => ""),
    exec(`git -C '${esc}' rev-parse --abbrev-ref HEAD 2>/dev/null || true`).catch(() => ""),
    exec(`git -C '${esc}' rev-parse --show-toplevel 2>/dev/null || true`).catch(() => ""),
  ]);
  const repo = normalizeRemote(remote.trim());
  const top = toplevel.trim();
  const br = branch.trim();
  const worktree = top && br ? { name: top.split("/").pop() || top, branch: br } : null;
  return { repo, worktree };
}

export function normalizeRemote(url: string): string | null {
  if (!url) return null;
  const clean = url.replace(/\.git$/, "");
  const ssh = clean.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = clean.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}
