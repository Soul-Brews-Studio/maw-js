import { Hono } from "hono";
import { cfgLimit } from "../config";
import { homedir } from "os";
import { join, basename } from "path";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";

export const logsApi = new Hono();

const projectsDir = join(homedir(), ".claude", "projects");

/** Extract agent name from project dir name, e.g. "-home-nat-Code-...-neo-oracle" → "neo-oracle" */
function agentFromDir(dirName: string): string {
  // Dir names are hyphen-joined paths. Take the last meaningful segment(s).
  // e.g. "-home-nat-Code-github-com-laris-co-neo-oracle-wt-1-foo" → "neo-oracle-wt-1-foo"
  // We split on known org prefixes and take what's after
  const orgPrefixes = [
    "laris-co-",
    "Soul-Brews-Studio-",
    "nazt-",
    "DustBoy-PM25-",
    "FloodBoy-CM-",
  ];
  for (const prefix of orgPrefixes) {
    const idx = dirName.indexOf(prefix);
    if (idx !== -1) return dirName.slice(idx + prefix.length);
  }
  // Fallback: last segment after the last known path separator pattern
  const parts = dirName.split("-");
  return parts.slice(-2).join("-");
}

/** List all JSONL files under a project dir (max depth 2 for subagents/) */
function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry.endsWith(".jsonl")) {
        files.push(full);
      } else {
        try {
          if (statSync(full).isDirectory()) {
            for (const sub of readdirSync(full)) {
              if (sub.endsWith(".jsonl")) files.push(join(full, sub));
            }
          }
        } catch { /* expected: dir entry may not be accessible */ }
      }
    }
  } catch { /* expected: log dir may not exist */ }
  return files;
}

/** Count lines in a file without reading entire content */
function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

// GET /api/logs?q=error&agent=neo&limit=50
logsApi.get("/logs", (c) => {
  const q = c.req.query("q") || "";
  const agentFilter = c.req.query("agent") || "";
  const limit = Math.min(parseInt(c.req.query("limit") || String(cfgLimit("logsDefault")), 10) || cfgLimit("logsDefault"), cfgLimit("logsMax"));

  if (!existsSync(projectsDir)) {
    return c.json({ entries: [], total: 0 });
  }

  const results: any[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return c.json({ entries: [], total: 0 });
  }

  for (const dir of dirs) {
    const agent = agentFromDir(dir);

    // Filter by agent name (substring match)
    if (agentFilter && !agent.toLowerCase().includes(agentFilter.toLowerCase())) {
      continue;
    }

    const dirPath = join(projectsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const jsonlFiles = findJsonlFiles(dirPath);

    for (const file of jsonlFiles) {
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n").filter((l) => l.length > 0);

        // Search from end (most recent entries first)
        for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
          const line = lines[i];

          // Text query filter (case-insensitive grep)
          if (q && !line.toLowerCase().includes(q.toLowerCase())) continue;

          try {
            const parsed = JSON.parse(line);
            // Skip file-history-snapshot and progress-only entries with no content
            if (parsed.type === "file-history-snapshot") continue;

            results.push({
              agent,
              sessionId: parsed.sessionId || null,
              type: parsed.type || null,
              timestamp: parsed.timestamp || null,
              gitBranch: parsed.gitBranch || null,
              message:
                parsed.message?.role === "user"
                  ? {
                      role: "user",
                      content:
                        typeof parsed.message.content === "string"
                          ? parsed.message.content.slice(0, cfgLimit("logsTruncate"))
                          : "[structured]",
                    }
                  : parsed.message?.role === "assistant"
                    ? {
                        role: "assistant",
                        content:
                          typeof parsed.message.content === "string"
                            ? parsed.message.content.slice(0, cfgLimit("logsTruncate"))
                            : Array.isArray(parsed.message.content)
                              ? "[tool_use/text blocks]"
                              : "[structured]",
                      }
                    : null,
            });
          } catch {
            // Skip malformed JSON
          }
        }
      } catch {
        // Skip unreadable files
      }

      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
  }

  // Sort by timestamp descending
  results.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });

  return c.json({ entries: results.slice(0, limit), total: results.length });
});

// GET /api/logs/agents — list all agents with session file count + total lines
logsApi.get("/logs/agents", (c) => {
  if (!existsSync(projectsDir)) {
    return c.json({ agents: [], total: 0 });
  }

  const agentMap = new Map<string, { files: number; lines: number; lastModified: string | null }>();

  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return c.json({ agents: [], total: 0 });
  }

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const agent = agentFromDir(dir);
    const jsonlFiles = findJsonlFiles(dirPath);

    if (jsonlFiles.length === 0) continue;

    const existing = agentMap.get(agent) || { files: 0, lines: 0, lastModified: null };

    let latestMtime: Date | null = null;
    for (const file of jsonlFiles) {
      existing.files++;
      existing.lines += countLines(file);
      try {
        const mtime = statSync(file).mtime;
        if (!latestMtime || mtime > latestMtime) latestMtime = mtime;
      } catch { /* expected: file may have been deleted */ }
    }

    if (latestMtime) {
      const mtimeStr = latestMtime.toISOString();
      if (!existing.lastModified || mtimeStr > existing.lastModified) {
        existing.lastModified = mtimeStr;
      }
    }

    agentMap.set(agent, existing);
  }

  const agents = Array.from(agentMap.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return b.lastModified.localeCompare(a.lastModified);
    });

  return c.json({ agents, total: agents.length });
});
