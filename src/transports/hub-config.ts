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
      const validation = validateWorkspaceConfig(raw);
      if (validation.ok) {
        configs.push(raw as WorkspaceConfig);
      } else {
        console.warn(`[hub] invalid workspace config: ${file} (${validation.reason})`);
      }
    } catch (err) {
      console.warn(`[hub] failed to parse workspace config: ${file}`, err);
    }
  }

  return configs;
}

/** Validate workspace config shape */
export function validateWorkspaceConfig(raw: any): { ok: true } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  if (typeof raw.id !== "string" || raw.id.length === 0) return { ok: false, reason: "missing/empty id" };
  if (typeof raw.hubUrl !== "string" || raw.hubUrl.length === 0) return { ok: false, reason: "missing/empty hubUrl" };
  if (typeof raw.token !== "string" || raw.token.length === 0) return { ok: false, reason: "missing/empty token" };
  if (!Array.isArray(raw.sharedAgents)) return { ok: false, reason: "sharedAgents must be array" };
  try {
    const url = new URL(raw.hubUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return { ok: false, reason: `hubUrl must be ws:|wss: (got ${url.protocol})` };
    }
  } catch {
    return { ok: false, reason: "hubUrl not a valid URL" };
  }
  return { ok: true };
}
