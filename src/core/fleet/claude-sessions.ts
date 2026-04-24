/**
 * Claude Code session discovery — Phase 1 (read-only).
 *
 * Scans ~/.claude/projects/ for JSONL session files and correlates with
 * running `claude` processes via /proc/<pid>/cwd (Linux) or lsof (macOS).
 *
 * Localhost-only. Never expose via federation in Phase 1.
 */

import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

export interface ClaudeSession {
  sessionId: string;
  projectPath: string;
  repo: string | null;
  worktree: { name: string; branch: string } | null;
  pid: number | null;
  ppid: number | null;
  parentChain: string[];
  tmuxTarget: string | null;
  triggeredFrom: "maw-wake" | "tmux" | "desktop" | "cron" | "unknown";
  status: "active" | "idle" | "ended";
  lastActivityAt: string;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  sizeBytes: number;
}

interface PidInfo { pid: number; ppid: number; cwd: string; command: string }

// ── Path encoding ────────────────────────────────────────────────

/** Decode Claude Code project dir name → absolute path. */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

// ── PID discovery (cached 5s) ────────────────────────────────────

let pidCache: { data: PidInfo[]; ts: number } | null = null;

function listClaudePids(): PidInfo[] {
  const now = Date.now();
  if (pidCache && now - pidCache.ts < 5_000) return pidCache.data;
  const results: PidInfo[] = [];
  try {
    const raw = execSync(`ps -eo pid,ppid,command 2>/dev/null | grep '[c]laude'`, {
      encoding: "utf-8", timeout: 3000,
    });
    for (const line of raw.split("\n").filter(Boolean)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || m[3].includes("grep")) continue;
      const [, pidStr, ppidStr, command] = m;
      let cwd = "";
      try {
        cwd = process.platform === "linux"
          ? execSync(`readlink /proc/${pidStr}/cwd 2>/dev/null`, { encoding: "utf-8", timeout: 1000 }).trim()
          : execSync(`lsof -p ${pidStr} -Fn 2>/dev/null | grep '^n/' | head -1`, { encoding: "utf-8", timeout: 2000 }).replace(/^n/, "").trim();
      } catch { /* cwd not resolvable */ }
      if (cwd) results.push({ pid: +pidStr, ppid: +ppidStr, cwd, command });
    }
  } catch { /* no claude processes */ }
  pidCache = { data: results, ts: now };
  return results;
}

// ── Parent chain + trigger classification ────────────────────────

function classifyTrigger(ppid: number): { chain: string[]; trigger: ClaudeSession["triggeredFrom"] } {
  const chain: string[] = [];
  let cur = ppid;
  const seen = new Set<number>();
  for (let i = 0; i < 10 && cur > 1 && !seen.has(cur); i++) {
    seen.add(cur);
    try {
      const info = execSync(`ps -o comm=,ppid= -p ${cur} 2>/dev/null`, { encoding: "utf-8", timeout: 1000 }).trim();
      const parts = info.split(/\s+/);
      const comm = parts.slice(0, -1).join(" ");
      cur = +(parts.at(-1) || "0");
      if (comm) chain.push(comm);
    } catch { break; }
  }
  const j = chain.join(" ").toLowerCase();
  if (j.includes("maw")) return { chain, trigger: "maw-wake" };
  if (j.includes("tmux")) return { chain, trigger: "tmux" };
  if (j.includes("cron") || j.includes("systemd")) return { chain, trigger: "cron" };
  if (j.includes("dock") || j.includes("launchd")) return { chain, trigger: "desktop" };
  return { chain, trigger: "unknown" };
}

// ── Git helpers ──────────────────────────────────────────────────

function resolveRepo(cwd: string): string | null {
  try {
    return execSync(`git -C '${cwd}' remote get-url origin 2>/dev/null`, { encoding: "utf-8", timeout: 2000 })
      .trim().replace(/^(ssh:\/\/)?git@/, "").replace(/^https?:\/\//, "").replace(/:/, "/").replace(/\.git$/, "");
  } catch { return null; }
}

function resolveWorktree(cwd: string): ClaudeSession["worktree"] {
  try {
    const raw = execSync(`git -C '${cwd}' worktree list --porcelain 2>/dev/null`, { encoding: "utf-8", timeout: 2000 });
    for (const block of raw.split("\n\n").filter(Boolean)) {
      const lines = block.split("\n");
      const wt = lines.find(l => l.startsWith("worktree "))?.slice(9);
      const br = lines.find(l => l.startsWith("branch "))?.slice(7).replace("refs/heads/", "");
      if (wt && br && resolve(wt) === resolve(cwd)) return { name: wt.split("/").pop()!, branch: br };
    }
  } catch { /* not a worktree */ }
  return null;
}

// ── Last-message extraction (tail-based, avoids full read) ───────

function extractLastMessages(filePath: string): { lastUser: string | null; lastAssistant: string | null } {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  try {
    const tail = execSync(`tail -100 '${filePath}' 2>/dev/null`, {
      encoding: "utf-8", timeout: 2000, maxBuffer: 512 * 1024,
    });
    for (const line of tail.split("\n").filter(Boolean).reverse()) {
      try {
        const e = JSON.parse(line);
        if (!lastUser && e.type === "user" && e.message?.content) {
          const c = typeof e.message.content === "string"
            ? e.message.content
            : e.message.content?.find?.((b: any) => b.type === "text")?.text;
          if (c) lastUser = c.slice(0, 200);
        }
        if (!lastAssistant && e.type === "assistant" && e.message?.content) {
          const blocks = Array.isArray(e.message.content) ? e.message.content : [];
          const t = blocks.find((b: any) => b.type === "text")?.text;
          if (t) lastAssistant = t.slice(0, 200);
        }
        if (lastUser && lastAssistant) break;
      } catch { /* malformed line */ }
    }
  } catch { /* file read error */ }
  return { lastUser, lastAssistant };
}

// ── Main discovery ───────────────────────────────────────────────

let sessionCache: { data: ClaudeSession[]; ts: number } | null = null;

export async function listClaudeSessions(): Promise<ClaudeSession[]> {
  const now = Date.now();
  if (sessionCache && now - sessionCache.ts < 5_000) return sessionCache.data;

  const claudeDir = join(homedir(), ".claude", "projects");
  const pids = listClaudePids();
  const pidByCwd = new Map(pids.map(p => [p.cwd, p]));
  const results: ClaudeSession[] = [];

  let projectDirs: string[];
  try { projectDirs = readdirSync(claudeDir).filter(d => d.startsWith("-")); }
  catch { return []; }

  for (const encoded of projectDirs) {
    const projectPath = decodeProjectDir(encoded);
    const dirPath = join(claudeDir, encoded);
    let files: string[];
    try { files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl") && !f.includes("subagents")); }
    catch { continue; }

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = join(dirPath, file);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(filePath); } catch { continue; }

      const mtimeMs = st.mtimeMs;
      const ageMs = now - mtimeMs;
      if (ageMs > 86_400_000) continue; // skip > 24h old

      const pidInfo = pidByCwd.get(projectPath);
      const status: ClaudeSession["status"] = pidInfo
        ? (ageMs < 120_000 ? "active" : "idle")
        : "ended";

      const { chain, trigger } = pidInfo
        ? classifyTrigger(pidInfo.ppid)
        : { chain: [] as string[], trigger: "unknown" as const };

      const tmuxTarget = chain.some(c => c.toLowerCase().includes("tmux"))
        ? `(tmux: ${projectPath.split("/").pop()})` : null;

      results.push({
        sessionId, projectPath,
        repo: resolveRepo(projectPath),
        worktree: resolveWorktree(projectPath),
        pid: pidInfo?.pid ?? null,
        ppid: pidInfo?.ppid ?? null,
        parentChain: chain, tmuxTarget, triggeredFrom: trigger, status,
        lastActivityAt: new Date(mtimeMs).toISOString(),
        ...extractLastMessages(filePath),
        sizeBytes: st.size,
      });
    }
  }

  results.sort((a, b) => {
    const ord = { active: 0, idle: 1, ended: 2 };
    return (ord[a.status] - ord[b.status])
      || (new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
  });

  sessionCache = { data: results, ts: now };
  return results;
}
