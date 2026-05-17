import { Elysia } from "elysia";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { scanTeams } from "../engine/teams";

export interface TeamsApiDeps {
  scanTeams?: typeof scanTeams;
  readFileSync?: typeof readFileSync;
  readdirSync?: typeof readdirSync;
  join?: typeof join;
  homedir?: typeof homedir;
}

export function createTeamsApi(deps: TeamsApiDeps = {}) {
  const scan = deps.scanTeams ?? scanTeams;
  const readFile = deps.readFileSync ?? readFileSync;
  const readDir = deps.readdirSync ?? readdirSync;
  const joinPath = deps.join ?? join;
  const home = deps.homedir ?? homedir;

  const teamsApi = new Elysia();

  teamsApi.get("/teams", async () => {
    const teams = await scan();
    return { teams, total: teams.length };
  });

  teamsApi.get("/teams/:name", ({ params, set }) => {
    const configPath = joinPath(home(), ".claude/teams", params.name, "config.json");
    try { return JSON.parse(readFile(configPath, "utf-8")); }
    catch { set.status = 404; return { error: "team not found" }; }
  });

  teamsApi.get("/teams/:name/tasks", ({ params }) => {
    const tasksDir = joinPath(home(), ".claude/tasks", params.name);
    try {
      const files = readDir(tasksDir).filter(f => f.endsWith(".json"));
      const tasks = files.map(f => {
        try { return JSON.parse(readFile(joinPath(tasksDir, f), "utf-8")); }
        catch { return null; }
      }).filter(Boolean);
      return { tasks, total: tasks.length };
    } catch { return { tasks: [], total: 0 }; }
  });

  return teamsApi;
}

export const teamsApi = createTeamsApi();
