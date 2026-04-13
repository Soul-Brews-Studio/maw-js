import { Elysia } from "elysia";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanTeams } from "../engine/teams";

export const teamsApi = new Elysia();

teamsApi.get("/teams", async () => {
  const teams = await scanTeams();
  return { teams, total: teams.length };
});

teamsApi.get("/teams/:name", ({ params, set }) => {
  const configPath = join(homedir(), ".claude/teams", params.name, "config.json");
  try { return JSON.parse(readFileSync(configPath, "utf-8")); }
  catch { set.status = 404; return { error: "team not found" }; }
});

teamsApi.get("/teams/:name/tasks", ({ params }) => {
  const tasksDir = join(homedir(), ".claude/tasks", params.name);
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith(".json"));
    const tasks = files.map(f => {
      try { return JSON.parse(readFileSync(join(tasksDir, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    return { tasks, total: tasks.length };
  } catch { return { tasks: [], total: 0 }; }
});
