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

export const logsApi = new Elysia()
  .use(logsAgentsApi);

// GET /api/logs?q=error&agent=neo&limit=50
logsApi.get("/logs", ({ query }) => {
  const q = query.q || "";
  const agentFilter = query.agent || "";
  const limit = Math.min(parseInt(query.limit || String(cfgLimit("logsDefault")), 10) || cfgLimit("logsDefault"), cfgLimit("logsMax"));

  if (!existsSync(projectsDir)) {
    return { entries: [], total: 0 };
  }

  const results: unknown[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return { entries: [], total: 0 };
  }

  for (const dir of dirs) {
    const agent = agentFromDir(dir);

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

  results.sort((a, b) => {
    const aTs = (a as Record<string, unknown>)?.timestamp;
    const bTs = (b as Record<string, unknown>)?.timestamp;
    if (!aTs) return 1;
    if (!bTs) return -1;
    return String(bTs).localeCompare(String(aTs));
  });

  return { entries: results.slice(0, limit), total: results.length };
});
