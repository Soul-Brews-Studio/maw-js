import { Hono } from "hono";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanTeams } from "../engine/teams";

export const teamsApi = new Hono();

teamsApi.get("/teams", async (c) => {
  const teams = await scanTeams();
  return c.json({ teams, total: teams.length });
});

teamsApi.get("/teams/:name", (c) => {
  const name = c.req.param("name");
  const configPath = join(homedir(), ".claude/teams", name, "config.json");
  try { return c.json(JSON.parse(readFileSync(configPath, "utf-8"))); }
  catch { return c.json({ error: "team not found" }, 404); }
});

teamsApi.get("/teams/:name/tasks", (c) => {
  const name = c.req.param("name");
  const tasksDir = join(homedir(), ".claude/tasks", name);
  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith(".json"));
    const tasks = files.map(f => {
      try { return JSON.parse(readFileSync(join(tasksDir, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    return c.json({ tasks, total: tasks.length });
  } catch { return c.json({ tasks: [], total: 0 }); }
});
