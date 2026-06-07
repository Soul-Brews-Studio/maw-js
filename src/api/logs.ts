import { Elysia } from "elysia";
import { cfgLimit } from "../config";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { agentFromDir, findJsonlFiles } from "./logs-helpers";
import { logsAgentsApi } from "./logs-agents";

export { agentFromDir, findJsonlFiles } from "./logs-helpers";
export { logsAgentsApi } from "./logs-agents";

const projectsDir = join(homedir(), ".claude", "projects");

export interface LogsApiDeps {
  projectsDir: string;
  cfgLimit: typeof cfgLimit;
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
  join: typeof join;
  agentFromDir: typeof agentFromDir;
  findJsonlFiles: typeof findJsonlFiles;
  logsAgentsApi: Elysia;
}

export function createLogsApi(deps: LogsApiDeps = {
  projectsDir,
  cfgLimit,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  join,
  agentFromDir,
  findJsonlFiles,
  logsAgentsApi,
}) {
  const api = new Elysia()
    .use(deps.logsAgentsApi);

  // GET /api/logs?q=error&agent=neo&limit=50
  api.get("/logs", ({ query }) => {
    const q = query.q || "";
    const agentFilter = query.agent || "";
    const limit = Math.min(parseInt(query.limit || String(deps.cfgLimit("logsDefault")), 10) || deps.cfgLimit("logsDefault"), deps.cfgLimit("logsMax"));

    if (!deps.existsSync(deps.projectsDir)) {
      return { entries: [], total: 0 };
    }

    const results: any[] = [];
    let dirs: string[];
    try {
      dirs = deps.readdirSync(deps.projectsDir);
    } catch {
      return { entries: [], total: 0 };
    }

    for (const dir of dirs) {
      const agent = deps.agentFromDir(dir);

      if (agentFilter && !agent.toLowerCase().includes(agentFilter.toLowerCase())) {
        continue;
      }

      const dirPath = deps.join(deps.projectsDir, dir);
      try {
        if (!deps.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const jsonlFiles = deps.findJsonlFiles(dirPath);

      for (const file of jsonlFiles) {
        try {
          const content = deps.readFileSync(file, "utf-8") as string;
          const lines = content.split("\n").filter((l) => l.length > 0);

          for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
            const line = lines[i];

            if (q && !line.toLowerCase().includes(q.toLowerCase())) continue;

            try {
              const parsed = JSON.parse(line);
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
                            ? parsed.message.content.slice(0, deps.cfgLimit("logsTruncate"))
                            : "[structured]",
                      }
                    : parsed.message?.role === "assistant"
                      ? {
                        role: "assistant",
                        content:
                          typeof parsed.message.content === "string"
                            ? parsed.message.content.slice(0, deps.cfgLimit("logsTruncate"))
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

    results.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    return { entries: results.slice(0, limit), total: results.length };
  });

  return api;
}

export const logsApi = createLogsApi();
