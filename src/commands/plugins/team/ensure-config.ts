import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { TEAMS_DIR, type TeamConfig } from "./team-helpers";

export function ensureTeamConfig(name: string, description?: string): boolean {
  const configDir = join(TEAMS_DIR, name);
  const configPath = join(configDir, "config.json");
  if (existsSync(configPath)) return false;

  mkdirSync(configDir, { recursive: true });
  const config: TeamConfig = {
    name,
    description: description ?? `Auto-created team for session ${name}`,
    members: [],
    createdAt: Date.now(),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return true;
}
