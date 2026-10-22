/**
 * Claude Code session discovery — Phase 1 (read-only).
 *
 * Scans ~/.claude/projects/ for JSONL session files and correlates with
 * running `claude` processes via /proc/<pid>/cwd (Linux) or lsof (macOS).
 *
 * Localhost-only. Never expose via federation in Phase 1.
 *
 * Fully async: every subprocess call goes through an async exec seam so a
 * fleet scan never blocks the single Bun event loop backing `maw serve`.
 * Per-session work runs concurrently (small pool) and per-cwd git/worktree
 * resolution is deduped within a scan via a Map of in-flight promises.
 * Message tail/count no longer shell out at all — they read the jsonl file
 * directly with fs/promises.
 */

import type { Stats } from "fs";
import { open, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ExecAsync = (
  command: string,
  options?: { timeout?: number; maxBuffer?: number },
) => Promise<string>;

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
  messageCount: number;
  sizeBytes: number;
}

interface PidInfo { pid: number; ppid: number; cwd: string; command: string }

export interface ClaudeSessionDeps {
  /** Async shell-out seam. Runs `command` via a shell and resolves with stdout. */
  execSync?: ExecAsync;
}

/**
 * Default async exec: runs a shell command via execFile("/bin/sh", ["-c", ...])
 * so callers can keep passing shell strings (pipes, redirects) as before,
 * without ever blocking the event loop.
 */
const defaultExecAsync: ExecAsync = async (command, options) => {
  const { stdout } = await execFileAsync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer ?? 1024 * 1024,
  });
  return stdout;
};

// ── Tiny concurrency pool (no new dependencies) ──────────────────

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Path encoding ────────────────────────────────────────────────

/** Decode Claude Code project dir name → absolute path. */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

// ── PID discovery (cached 5s, invoked once per scan) ─────────────

let pidCache: { data: PidInfo[]; ts: number } | null = null;

async function listClaudePids(exec: ExecAsync): Promise<PidInfo[]> {
  if (process.env.MAW_CLAUDE_SKIP_PID_SCAN === "1") return [];
  const now = Date.now();
  if (pidCache && now - pidCache.ts < 5_000) return pidCache.data;
  const results: PidInfo[] = [];
  try {
    const raw = await exec(`ps -eo pid,ppid,command 2>/dev/null | grep '[c]laude'`, { timeout: 3000 });
    const rows: { pidStr: string; ppidStr: string; command: string }[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || m[3].includes("grep")) continue;
      rows.push({ pidStr: m[1], ppidStr: m[2], command: m[3] });
    }
    await mapPool(rows, 8, async ({ pidStr, ppidStr, command }) => {
      let cwd = "";
      try {
        cwd = process.platform === "linux"
          ? (await exec(`readlink /proc/${pidStr}/cwd 2>/dev/null`, { timeout: 1000 })).trim()
          : (await exec(`lsof -p ${pidStr} -Fn 2>/dev/null | grep '^n/' | head -1`, { timeout: 2000 })).replace(/^n/, "").trim();
      } catch { /* cwd not resolvable */ }
      if (cwd) results.push({ pid: +pidStr, ppid: +ppidStr, cwd, command });
    });
  } catch { /* no claude processes */ }
  pidCache = { data: results, ts: now };
  return results;
}

// ── Parent chain + trigger classification ────────────────────────

async function classifyTrigger(
  ppid: number,
  exec: ExecAsync,
): Promise<{ chain: string[]; trigger: ClaudeSession["triggeredFrom"] }> {
  const chain: string[] = [];
  let cur = ppid;
  const seen = new Set<number>();
  for (let i = 0; i < 10 && cur > 1 && !seen.has(cur); i++) {
    seen.add(cur);
    try {
      const info = (await exec(`ps -o comm=,ppid= -p ${cur} 2>/dev/null`, { timeout: 1000 })).trim();
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

async function resolveRepo(cwd: string, exec: ExecAsync): Promise<string | null> {
  try {
    const raw = await exec(`git -C '${cwd}' remote get-url origin 2>/dev/null`, { timeout: 2000 });
    return raw.trim().replace(/^(ssh:\/\/)?git@/, "").replace(/^https?:\/\//, "").replace(/:/, "/").replace(/\.git$/, "");
  } catch { return null; }
}

async function resolveWorktree(cwd: string, exec: ExecAsync): Promise<ClaudeSession["worktree"]> {
  try {
    const raw = await exec(`git -C '${cwd}' worktree list --porcelain 2>/dev/null`, { timeout: 2000 });
    for (const block of raw.split("\n\n").filter(Boolean)) {
      const lines = block.split("\n");
      const wt = lines.find(l => l.startsWith("worktree "))?.slice(9);
      const br = lines.find(l => l.startsWith("branch "))?.slice(7).replace("refs/heads/", "");
      if (wt && br && resolve(wt) === resolve(cwd)) return { name: wt.split("/").pop()!, branch: br };
    }
  } catch { /* not a worktree */ }
  return null;
}

interface GitInfo {
  repo: string | null;
  worktree: ClaudeSession["worktree"];
}

/** Per-cwd git metadata, deduped within a scan (many sessions share a projectPath). */
function makeGitInfoResolver(exec: ExecAsync): (cwd: string) => Promise<GitInfo> {
  const cache = new Map<string, Promise<GitInfo>>();
  return (cwd: string) => {
    let p = cache.get(cwd);
    if (!p) {
      p = Promise.all([resolveRepo(cwd, exec), resolveWorktree(cwd, exec)])
        .then(([repo, worktree]) => ({ repo, worktree }));
      cache.set(cwd, p);
    }
    return p;
  };
}

// ── Last-message extraction (reads only the tail of the file, no subprocess) ─

const TAIL_READ_BYTES = 64 * 1024;

async function readTail(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { text: "", truncated: false };
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return { text: buf.toString("utf-8"), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

async function extractLastMessages(
  filePath: string,
): Promise<{ lastUser: string | null; lastAssistant: string | null }> {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  try {
    const { text, truncated } = await readTail(filePath, TAIL_READ_BYTES);
    const lines = text.split("\n").filter(Boolean);
    // A tail read may start mid-line; drop a possibly-truncated first line,
    // but only when the read actually started past byte 0.
    if (truncated && lines.length > 1) lines.shift();
    for (const line of lines.reverse()) {
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

/** Count newline-delimited records without buffering the whole file or shelling out. */
async function countSessionMessages(filePath: string): Promise<number> {
  const CHUNK = 64 * 1024;
  try {
    const handle = await open(filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return 0;
      let count = 0;
      let sawAnyByte = false;
      let lastByte = -1;
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      while (pos < size) {
        const toRead = Math.min(CHUNK, size - pos);
        const { bytesRead } = await handle.read(buf, 0, toRead, pos);
        if (bytesRead <= 0) break;
        sawAnyByte = true;
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) count++;
        }
        lastByte = buf[bytesRead - 1];
        pos += bytesRead;
      }
      // A final line without a trailing newline still counts as a record
      // (matches `awk 'END{print NR}'` semantics).
      if (sawAnyByte && lastByte !== 0x0a) count++;
      return count;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

// ── Main discovery ───────────────────────────────────────────────

let sessionCache: { data: ClaudeSession[]; ts: number } | null = null;
const SESSION_CACHE_TTL_MS = 15_000;
const PER_SESSION_CONCURRENCY = 8;

export function __resetClaudeSessionCachesForTests(): void {
  pidCache = null;
  sessionCache = null;
}

function claudeProjectsDir(): string {
  return process.env.MAW_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

interface SessionFileEntry {
  projectPath: string;
  dirPath: string;
  file: string;
}

export async function listClaudeSessions(deps: ClaudeSessionDeps = {}): Promise<ClaudeSession[]> {
  const exec = deps.execSync ?? defaultExecAsync;
  const now = Date.now();
  if (sessionCache && now - sessionCache.ts < SESSION_CACHE_TTL_MS) return sessionCache.data;

  const claudeDir = claudeProjectsDir();
  const pids = await listClaudePids(exec);
  const pidByCwd = new Map(pids.map(p => [p.cwd, p]));
  const gitInfoFor = makeGitInfoResolver(exec);

  let projectDirs: string[];
  try { projectDirs = (await readdir(claudeDir)).filter(d => d.startsWith("-")); }
  catch { return []; }

  // Read each project dir's listing concurrently (async, off the event loop)
  // instead of a blocking readdirSync per directory.
  const perDir = await mapPool(projectDirs, PER_SESSION_CONCURRENCY, async (encoded) => {
    const projectPath = decodeProjectDir(encoded);
    const dirPath = join(claudeDir, encoded);
    let files: string[];
    try { files = (await readdir(dirPath)).filter(f => f.endsWith(".jsonl") && !f.includes("subagents")); }
    catch { return [] as SessionFileEntry[]; }
    return files.map(file => ({ projectPath, dirPath, file }));
  });
  const entries: SessionFileEntry[] = perDir.flat();

  const perFile = await mapPool(entries, PER_SESSION_CONCURRENCY, async ({ projectPath, dirPath, file }) => {
    const sessionId = file.replace(".jsonl", "");
    const filePath = join(dirPath, file);
    let st: Stats;
    try { st = await stat(filePath); } catch { return null; }

    const mtimeMs = st.mtimeMs;
    const ageMs = now - mtimeMs;
    if (ageMs > 86_400_000) return null; // skip > 24h old

    const pidInfo = pidByCwd.get(projectPath);
    const status: ClaudeSession["status"] = pidInfo
      ? (ageMs < 120_000 ? "active" : "idle")
      : "ended";

    const [{ chain, trigger }, gitInfo, { lastUser, lastAssistant }, messageCount] = await Promise.all([
      pidInfo
        ? classifyTrigger(pidInfo.ppid, exec)
        : Promise.resolve({ chain: [] as string[], trigger: "unknown" as const }),
      gitInfoFor(projectPath),
      extractLastMessages(filePath),
      countSessionMessages(filePath),
    ]);

    const tmuxTarget = chain.some(c => c.toLowerCase().includes("tmux"))
      ? `(tmux: ${projectPath.split("/").pop()})` : null;

    const session: ClaudeSession = {
      sessionId, projectPath,
      repo: gitInfo.repo,
      worktree: gitInfo.worktree,
      pid: pidInfo?.pid ?? null,
      ppid: pidInfo?.ppid ?? null,
      parentChain: chain, tmuxTarget, triggeredFrom: trigger, status,
      lastActivityAt: new Date(mtimeMs).toISOString(),
      lastUserMessage: lastUser,
      lastAssistantMessage: lastAssistant,
      messageCount,
      sizeBytes: st.size,
    };
    return session;
  });

  const results = perFile.filter((s): s is ClaudeSession => s !== null);

  results.sort((a, b) => {
    const ord = { active: 0, idle: 1, ended: 2 };
    return (ord[a.status] - ord[b.status])
      || (new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
  });

  sessionCache = { data: results, ts: now };
  return results;
}
