// Workspace Hub API — disk storage and in-memory cache

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { mawConfigPath, mawDataPath } from "../core/xdg";
import type { Workspace } from "./workspace-types";

export function workspaceDir(): string {
  return mawDataPath("workspaces");
}

export const WORKSPACE_DIR = workspaceDir();

function legacyWorkspaceDir(): string {
  return mawConfigPath("workspaces");
}

function candidateWorkspaceDirs(): string[] {
  const primary = workspaceDir();
  const legacy = legacyWorkspaceDir();
  return primary === legacy ? [primary] : [primary, legacy];
}

function ensureDir(): void {
  mkdirSync(workspaceDir(), { recursive: true });
}

/** In-memory cache, persisted to disk on mutation */
export const workspaces = new Map<string, Workspace>();

/** Load all workspaces from disk into memory */
export function loadAll() {
  if (workspaces.size > 0) return; // already loaded
  ensureDir();
  for (const dir of [...candidateWorkspaceDirs()].reverse()) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const ws = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Workspace;
          workspaces.set(ws.id, ws);
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir doesn't exist yet */ }
  }
}

export function persist(ws: Workspace) {
  ensureDir();
  writeFileSync(join(workspaceDir(), `${ws.id}.json`), JSON.stringify(ws, null, 2) + "\n", "utf-8");
}

/** Find workspace by join code (linear scan — small N) */
export function findByJoinCode(code: string): Workspace | undefined {
  for (const ws of workspaces.values()) {
    if (ws.joinCode === code && ws.joinCodeExpiresAt > Date.now()) return ws;
  }
  return undefined;
}

/** Check if in-memory cache is stale (empty and disk may have data) */
export function isCacheStale(): boolean {
  return workspaces.size === 0;
}
