/** Workspace config loading + validation for hub transport. */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "../core/paths";

export const WORKSPACES_DIR = join(CONFIG_DIR, "workspaces");
export const HEARTBEAT_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;

/** Workspace config from ~/.config/maw/workspaces/*.json */
export interface WorkspaceConfig {
  id: string;
  hubUrl: string;        // "wss://hub.example.com" or "ws://vps:3456"
  token: string;
  sharedAgents: string[];
}

/** Load all workspace configs from ~/.config/maw/workspaces/*.json */
export function loadWorkspaceConfigs(): WorkspaceConfig[] {
  if (!existsSync(WORKSPACES_DIR)) {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    return [];
  }

  const files = readdirSync(WORKSPACES_DIR).filter((f) => f.endsWith(".json"));
  const configs: WorkspaceConfig[] = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(WORKSPACES_DIR, file), "utf-8"));
      if (validateWorkspaceConfig(raw)) {
        configs.push(raw as WorkspaceConfig);
      } else {
        console.warn(`[hub] invalid workspace config: ${file}`);
      }
    } catch (err) {
      console.warn(`[hub] failed to parse workspace config: ${file}`, err);
    }
  }

  return configs;
}

/** Validate workspace config shape */
function validateWorkspaceConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return false;
  if (typeof r.hubUrl !== "string" || r.hubUrl.length === 0) return false;
  if (typeof r.token !== "string" || r.token.length === 0) return false;
  if (!Array.isArray(r.sharedAgents)) return false;
  try {
    const url = new URL(r.hubUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
  } catch {
    return false;
  }
  return true;
}
