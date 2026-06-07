import { Elysia } from "elysia";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, statSync, existsSync } from "fs";
import { agentFromDir, findJsonlFiles, countLines } from "./logs-helpers";

const projectsDir = join(homedir(), ".claude", "projects");

// GET /api/logs/agents — list all agents with session file count + total lines
export interface LogsAgentsApiDeps {
  projectsDir: string;
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  statSync: typeof statSync;
  join: typeof join;
  agentFromDir: typeof agentFromDir;
  findJsonlFiles: typeof findJsonlFiles;
  countLines: typeof countLines;
}

export function createLogsAgentsApi(deps: LogsAgentsApiDeps = {
  projectsDir,
  existsSync,
  readdirSync,
  statSync,
  join,
  agentFromDir,
  findJsonlFiles,
  countLines,
}) {
  return new Elysia().get("/logs/agents", () => {
    if (!deps.existsSync(deps.projectsDir)) {
      return { agents: [], total: 0 };
    }

    const agentMap = new Map<string, { files: number; lines: number; lastModified: string | null }>();

    let dirs: string[];
    try {
      dirs = deps.readdirSync(deps.projectsDir);
    } catch {
      return { agents: [], total: 0 };
    }

    for (const dir of dirs) {
      const dirPath = deps.join(deps.projectsDir, dir);
      try {
        if (!deps.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const agent = deps.agentFromDir(dir);
      const jsonlFiles = deps.findJsonlFiles(dirPath);

      if (jsonlFiles.length === 0) continue;

      const existing = agentMap.get(agent) || { files: 0, lines: 0, lastModified: null };

      let latestMtime: Date | null = null;
      for (const file of jsonlFiles) {
        existing.files++;
        existing.lines += deps.countLines(file);
        try {
          const mtime = deps.statSync(file).mtime;
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

    return { agents, total: agents.length };
  });
}

export const logsAgentsApi = createLogsAgentsApi();
