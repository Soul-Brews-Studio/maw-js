import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const INDEX_PATH = join(homedir(), ".oracle", "token-index.json");

export interface SessionTokens {
  sessionId: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  turns: number;
  firstTs: string;
  lastTs: string;
  mtimeMs: number;
}

export interface TokenIndex {
  updatedAt: string;
  sessions: SessionTokens[];
}

/** Extract project display name from path */
function projectName(dirName: string): string {
  // -home-nat-Code-github-com-laris-co-neo-oracle → neo-oracle
  const parts = dirName.split("-");
  // Find the org/repo part — after "com" or after the last known org prefix
  const comIdx = parts.lastIndexOf("com");
  if (comIdx >= 0 && parts.length > comIdx + 2) {
    return parts.slice(comIdx + 2).join("-");
  }
  return dirName.slice(0, 30);
}

/** Scan a single session JSONL file for token usage */
function scanSession(filePath: string): Omit<SessionTokens, "project" | "mtimeMs"> | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0, turns = 0;
    let firstTs = "", lastTs = "";

    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.type === "assistant" && d.message?.usage) {
          const u = d.message.usage;
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheRead += u.cache_read_input_tokens || 0;
          cacheCreate += u.cache_creation_input_tokens || 0;
          turns++;
          const ts = d.timestamp || "";
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }
      } catch {}
    }

    if (turns === 0) return null;
    return { sessionId: basename(filePath, ".jsonl"), inputTokens, outputTokens, cacheRead, cacheCreate, turns, firstTs, lastTs };
  } catch {
    return null;
  }
}

/** Load existing index */
export function loadIndex(): TokenIndex {
  if (!existsSync(INDEX_PATH)) return { updatedAt: "", sessions: [] };
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { updatedAt: "", sessions: [] };
  }
}

/** Save index */
function saveIndex(index: TokenIndex) {
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

/** Full scan — index all session files, skip unchanged ones */
export function buildIndex(verbose = false): TokenIndex {
  const existing = loadIndex();
  const existingMap = new Map<string, SessionTokens>();
  for (const s of existing.sessions) existingMap.set(s.sessionId, s);

  const sessions: SessionTokens[] = [];
  let scanned = 0, skipped = 0, total = 0;

  if (!existsSync(CLAUDE_PROJECTS)) return { updatedAt: new Date().toISOString(), sessions: [] };

  for (const projDir of readdirSync(CLAUDE_PROJECTS)) {
    const projPath = join(CLAUDE_PROJECTS, projDir);
    if (!statSync(projPath).isDirectory()) continue;
    const project = projectName(projDir);

    let files: string[];
    try { files = readdirSync(projPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

    for (const file of files) {
      total++;
      const fp = join(projPath, file);
      const sid = basename(file, ".jsonl");
      const mtime = statSync(fp).mtimeMs;

      // Skip if unchanged since last index
      const prev = existingMap.get(sid);
      if (prev && prev.mtimeMs === mtime) {
        sessions.push(prev);
        skipped++;
        continue;
      }

      const result = scanSession(fp);
      if (result) {
        sessions.push({ ...result, project, mtimeMs: mtime });
        scanned++;
      }
    }
  }

  if (verbose) {
    console.log(`  scanned: ${scanned}, skipped: ${skipped}, total: ${total}`);
  }

  const index: TokenIndex = { updatedAt: new Date().toISOString(), sessions };
  saveIndex(index);
  return index;
}

/** Aggregate stats from index */
export interface TokenSummary {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  totalTurns: number;
  sessionCount: number;
  byProject: { project: string; input: number; output: number; turns: number }[];
  byDate: { date: string; input: number; output: number; turns: number }[];
}

export function summarize(index: TokenIndex): TokenSummary {
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0, totalTurns = 0;
  const byProject = new Map<string, { input: number; output: number; turns: number }>();
  const byDate = new Map<string, { input: number; output: number; turns: number }>();

  for (const s of index.sessions) {
    const inp = s.inputTokens + s.cacheRead;
    totalInput += inp;
    totalOutput += s.outputTokens;
    totalCacheRead += s.cacheRead;
    totalCacheCreate += s.cacheCreate;
    totalTurns += s.turns;

    // By project
    const p = byProject.get(s.project) || { input: 0, output: 0, turns: 0 };
    p.input += inp; p.output += s.outputTokens; p.turns += s.turns;
    byProject.set(s.project, p);

    // By date
    const date = s.lastTs?.slice(0, 10) || "unknown";
    const d = byDate.get(date) || { input: 0, output: 0, turns: 0 };
    d.input += inp; d.output += s.outputTokens; d.turns += s.turns;
    byDate.set(date, d);
  }

  return {
    totalInput, totalOutput, totalCacheRead, totalCacheCreate, totalTurns,
    sessionCount: index.sessions.length,
    byProject: [...byProject.entries()]
      .map(([project, v]) => ({ project, ...v }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byDate: [...byDate.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

/** Real-time token rate — scan recently modified session files */
export interface TokenRate {
  windowSeconds: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputPerMin: number;
  outputPerMin: number;
  totalPerMin: number;
  turns: number;
  byProject: { project: string; input: number; output: number; turns: number }[];
}

import { execSync } from "child_process";

// Cache per window size — 15s TTL
const _rateCache = new Map<number, { ts: number; result: TokenRate }>();
const RATE_CACHE_TTL = 15_000;

export function realtimeRate(windowSeconds = 300): TokenRate {
  const now = Date.now();
  const cached = _rateCache.get(windowSeconds);
  if (cached && now - cached.ts < RATE_CACHE_TTL) return cached.result;

  const cutoff = now - windowSeconds * 1000;
  const mmin = Math.ceil(windowSeconds / 60) + 1;

  let inputTokens = 0, outputTokens = 0, turns = 0;
  const byProject = new Map<string, { input: number; output: number; turns: number }>();

  if (!existsSync(CLAUDE_PROJECTS)) return emptyRate(windowSeconds);

  // Use find to get only recently modified files — much faster than scanning all dirs
  let recentFiles: string[];
  try {
    const out = execSync(
      `find ${CLAUDE_PROJECTS} -name "*.jsonl" -not -path "*/subagent*" -mmin -${mmin} 2>/dev/null`,
      { encoding: "utf-8", timeout: 3000 }
    );
    recentFiles = out.trim().split("\n").filter(Boolean);
  } catch {
    return emptyRate(windowSeconds);
  }

  for (const fp of recentFiles) {
    // Extract project name from path
    const parts = fp.replace(CLAUDE_PROJECTS + "/", "").split("/");
    const project = projectName(parts[0] || "unknown");

    try {
      // Read only tail of file for recent entries
      const raw = readFileSync(fp, "utf-8").slice(-200_000);

      for (const line of raw.split("\n")) {
        if (!line || line[0] !== "{") continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== "assistant" || !d.timestamp) continue;
          const ts = new Date(d.timestamp).getTime();
          if (isNaN(ts) || ts < cutoff) continue;
          const u = d.message?.usage;
          if (!u) continue;
          const inp = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
          const out = u.output_tokens || 0;
          inputTokens += inp;
          outputTokens += out;
          turns++;
          const p = byProject.get(project) || { input: 0, output: 0, turns: 0 };
          p.input += inp; p.output += out; p.turns++;
          byProject.set(project, p);
        } catch {}
      }
    } catch {}
  }

  const minutes = windowSeconds / 60;
  const totalTokens = inputTokens + outputTokens;
  const result: TokenRate = {
    windowSeconds,
    inputTokens, outputTokens, totalTokens,
    inputPerMin: Math.round(inputTokens / minutes),
    outputPerMin: Math.round(outputTokens / minutes),
    totalPerMin: Math.round(totalTokens / minutes),
    turns,
    byProject: [...byProject.entries()]
      .map(([project, v]) => ({ project, ...v }))
      .sort((a, b) => (b.input + b.output) - (a.input + a.output)),
  };

  _rateCache.set(windowSeconds, { ts: now, result });
  return result;
}

function emptyRate(windowSeconds: number): TokenRate {
  return { windowSeconds, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputPerMin: 0, outputPerMin: 0, totalPerMin: 0, turns: 0, byProject: [] };
}
