/**
 * Task Artifacts — persistent, discoverable output from team agent runs.
 *
 * Inspired by HiClaw's "task lifecycle IS the file lifecycle" pattern:
 *   Task assigned   → spec.md auto-written
 *   Task in progress → intermediate artifacts accumulate
 *   Task done       → result.md sealed
 *   Task discoverable → `maw artifacts ls` finds what any team produced
 *
 * Storage: ~/.maw/artifacts/{team}/{task-id}/
 *   ├── spec.md           # auto-written from TaskCreate description
 *   ├── result.md         # agent writes before reporting
 *   ├── attachments/      # files produced (images, data, etc.)
 *   └── meta.json         # agent, timing, status
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const ARTIFACTS_ROOT = join(homedir(), ".maw", "artifacts");

export interface ArtifactMeta {
  team: string;
  taskId: string;
  subject: string;
  owner?: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
  updatedAt: string;
  commitHash?: string;
}

// ─── Core operations ─────────────────────────────────────────────────────────

/** Create artifact dir + spec.md + meta.json when a task is created */
export function createArtifact(team: string, taskId: string, subject: string, description: string): string {
  const dir = join(ARTIFACTS_ROOT, team, taskId);
  mkdirSync(join(dir, "attachments"), { recursive: true });

  // spec.md — what was asked
  writeFileSync(join(dir, "spec.md"), `# ${subject}\n\n${description}\n`);

  // meta.json — tracking
  const meta: ArtifactMeta = {
    team, taskId, subject,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  return dir;
}

/** Update artifact metadata (status, owner, commit hash) */
export function updateArtifact(team: string, taskId: string, updates: Partial<ArtifactMeta>): void {
  const metaPath = join(ARTIFACTS_ROOT, team, taskId, "meta.json");
  if (!existsSync(metaPath)) return;
  const meta: ArtifactMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
  Object.assign(meta, updates, { updatedAt: new Date().toISOString() });
  // lgtm[js/file-system-race] — PRIVATE-PATH: artifacts under ~/.maw/artifacts/<team>/<task>/, see docs/security/file-system-race-stance.md
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/** Write result.md to an artifact (agent calls this before reporting) */
export function writeResult(team: string, taskId: string, content: string): void {
  const dir = join(ARTIFACTS_ROOT, team, taskId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.md"), content);
  updateArtifact(team, taskId, { status: "completed" });
}

/** Add an attachment file to an artifact */
export function addAttachment(team: string, taskId: string, name: string, data: Buffer | string): string {
  const dir = join(ARTIFACTS_ROOT, team, taskId, "attachments");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = join(dir, safeName);
  writeFileSync(dest, data);
  return dest;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface ArtifactSummary {
  team: string;
  taskId: string;
  subject: string;
  status: string;
  owner?: string;
  files: number;
  hasResult: boolean;
  createdAt: string;
}

/** List all artifacts, optionally filtered by team */
export function listArtifacts(teamFilter?: string): ArtifactSummary[] {
  if (!existsSync(ARTIFACTS_ROOT)) return [];
  const results: ArtifactSummary[] = [];

  const teams = teamFilter ? [teamFilter] : readdirSync(ARTIFACTS_ROOT).filter(
    (d) => statSync(join(ARTIFACTS_ROOT, d)).isDirectory(),
  );

  for (const team of teams) {
    const teamDir = join(ARTIFACTS_ROOT, team);
    if (!existsSync(teamDir)) continue;
    for (const taskId of readdirSync(teamDir)) {
      const taskDir = join(teamDir, taskId);
      if (!statSync(taskDir).isDirectory()) continue;
      const metaPath = join(taskDir, "meta.json");
      if (!existsSync(metaPath)) continue;

      const meta: ArtifactMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const attDir = join(taskDir, "attachments");
      const attCount = existsSync(attDir) ? readdirSync(attDir).length : 0;
      const fileCount = readdirSync(taskDir).length + attCount;

      results.push({
        team, taskId,
        subject: meta.subject,
        status: meta.status,
        owner: meta.owner,
        files: fileCount,
        hasResult: existsSync(join(taskDir, "result.md")),
        createdAt: meta.createdAt,
      });
    }
  }
  return results;
}

/** Get full artifact contents (spec + result + attachment list) */
export function getArtifact(team: string, taskId: string): {
  meta: ArtifactMeta;
  spec: string;
  result: string | null;
  attachments: string[];
  dir: string;
} | null {
  const dir = join(ARTIFACTS_ROOT, team, taskId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) return null;

  const meta: ArtifactMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const spec = existsSync(join(dir, "spec.md")) ? readFileSync(join(dir, "spec.md"), "utf-8") : "";
  const resultPath = join(dir, "result.md");
  const result = existsSync(resultPath) ? readFileSync(resultPath, "utf-8") : null;
  const attDir = join(dir, "attachments");
  const attachments = existsSync(attDir) ? readdirSync(attDir) : [];

  return { meta, spec, result, attachments, dir };
}

/** Get the artifact directory path (for agents to write into) */
export function artifactDir(team: string, taskId: string): string {
  return join(ARTIFACTS_ROOT, team, taskId);
}
