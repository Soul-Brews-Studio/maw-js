import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "fs";
import { cp } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getGhqRoot } from "maw-js/sdk";
import type { DoctorCheck } from "../impl";

const execFileAsync = promisify(execFile);
const DOUBLED_SEGMENT_RE = /\/github\.com\/github\.com\//i;

function canonicalGhqPath(doubledPath: string): string {
  return doubledPath.replace(DOUBLED_SEGMENT_RE, "/github.com/");
}

export type FixSessionsAction = "remap" | "clone+remap" | "cleanup-only";
export type FixSessionsOutcome = "planned" | "done" | "skipped" | "error";

export interface FixSessionsPair {
  doubled: string;
  canonical: string;
  canonicalExists: boolean;
  sessionDir: string;
  canonicalSessionDir: string;
  sessionCount: number;
  hasSessions: boolean;
  action: FixSessionsAction;
  cleanupTarget: string;
  outcome: FixSessionsOutcome;
  messages: string[];
}

export interface FixSessionsResult {
  ok: boolean;
  dryRun: boolean;
  quarantineRoot: string;
  pairs: FixSessionsPair[];
  checks: DoctorCheck[];
}

export interface FixSessionsDeps {
  ghqRoot?: () => string;
  claudeHome?: () => string;
  quarantineRoot?: () => string;
  exists?: (path: string) => boolean;
  readdir?: (path: string) => string[];
  stat?: (path: string) => { isDirectory(): boolean; isFile(): boolean };
  execFile?: (file: string, args: string[], opts?: { cwd?: string }) => Promise<void>;
  copyDir?: (from: string, to: string) => Promise<void>;
  moveDir?: (from: string, to: string) => Promise<void>;
}

export async function fixDoubledGithubSessions(opts: { dryRun: boolean }, deps: FixSessionsDeps = {}): Promise<FixSessionsResult> {
  const d = normalizeDeps(deps);
  const quarantineRoot = d.quarantineRoot();
  const pairs = discoverDoubledGithubSessionPairs(d, quarantineRoot);

  for (const pair of pairs) {
    if (opts.dryRun) {
      pair.outcome = "planned";
      pair.messages.push(`planned ${pair.action}`);
      continue;
    }
    try {
      if (pair.hasSessions) {
        if (!pair.canonicalExists) {
          await d.execFile("ghq", ["get", "-u", githubSlug(pair.canonical)]);
          pair.messages.push("cloned canonical repo");
          pair.canonicalExists = true;
        }
        await remapPairViaStagedClaudeHome(pair, d);
        pair.messages.push("remapped sessions with staged claude-path-migrate + rsync --ignore-existing");
      }
      await d.moveDir(pair.doubled, pair.cleanupTarget);
      pair.messages.push(`moved doubled dir to ${pair.cleanupTarget}`);
      pair.outcome = "done";
    } catch (e: any) {
      pair.outcome = "error";
      pair.messages.push(e?.message || String(e));
    }
  }

  const errored = pairs.filter(p => p.outcome === "error");
  const summary = summarizePairs(pairs);
  const checks: DoctorCheck[] = [{
    name: "sessions:fix-doubled-github",
    ok: errored.length === 0,
    severity: errored.length === 0 ? "info" : "warn",
    message: `${opts.dryRun ? "dry-run; " : ""}${summary}; quarantine=${quarantineRoot}`,
    details: { dryRun: opts.dryRun, quarantineRoot, pairs },
    fix: opts.dryRun ? ["maw doctor --fix-sessions"] : undefined,
  }];

  return { ok: errored.length === 0, dryRun: opts.dryRun, quarantineRoot, pairs, checks };
}

export function discoverDoubledGithubSessionPairs(deps: Required<FixSessionsDeps>, quarantineRoot: string): FixSessionsPair[] {
  const ghqRoot = deps.ghqRoot();
  const doubledRoot = join(ghqRoot, "github.com", "github.com");
  const doubledDirs = findRepoDirs(doubledRoot, deps).filter(p => DOUBLED_SEGMENT_RE.test(p));
  const seen = new Set<string>();
  const pairs: FixSessionsPair[] = [];
  for (const doubled of doubledDirs.sort()) {
    if (seen.has(doubled)) continue;
    seen.add(doubled);
    const canonical = canonicalGhqPath(doubled);
    const sessionDir = join(deps.claudeHome(), "projects", encodeClaudeProjectPath(doubled));
    const canonicalSessionDir = join(deps.claudeHome(), "projects", encodeClaudeProjectPath(canonical));
    const sessionCount = countJsonlSessions(sessionDir, deps);
    const canonicalExists = deps.exists(canonical);
    const action: FixSessionsAction = sessionCount > 0
      ? (canonicalExists ? "remap" : "clone+remap")
      : "cleanup-only";
    pairs.push({
      doubled,
      canonical,
      canonicalExists,
      sessionDir,
      canonicalSessionDir,
      sessionCount,
      hasSessions: sessionCount > 0,
      action,
      cleanupTarget: quarantinePath(quarantineRoot, doubled),
      outcome: "planned",
      messages: [],
    });
  }
  return pairs;
}

export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/[/.]/g, "-");
}

async function remapPairViaStagedClaudeHome(pair: FixSessionsPair, deps: Required<FixSessionsDeps>): Promise<void> {
  const stageRoot = mkdtempSync(join(tmpdir(), "maw-doctor-claude-stage-"));
  const stageClaudeHome = join(stageRoot, "claude");
  const stageProjects = join(stageClaudeHome, "projects");
  const stageSource = join(stageProjects, basename(pair.sessionDir));
  mkdirSync(stageProjects, { recursive: true });
  await deps.copyDir(pair.sessionDir, stageSource);
  await deps.execFile("claude-path-migrate", ["--claude-home", stageClaudeHome, "--map", `${pair.doubled}=${pair.canonical}`]);
  await deps.execFile("claude-path-migrate", ["--claude-home", stageClaudeHome, "--map", `${pair.doubled}=${pair.canonical}`, "--check"]);
  const stageCanonical = join(stageProjects, encodeClaudeProjectPath(pair.canonical));
  await deps.execFile("rsync", ["-a", "--ignore-existing", `${stageCanonical}/`, `${pair.canonicalSessionDir}/`]);
}

function normalizeDeps(deps: FixSessionsDeps): Required<FixSessionsDeps> {
  return {
    ghqRoot: deps.ghqRoot ?? (() => getGhqRoot()),
    claudeHome: deps.claudeHome ?? (() => process.env.CLAUDE_HOME || join(process.env.HOME || "", ".claude")),
    quarantineRoot: deps.quarantineRoot ?? (() => join(tmpdir(), `maw-doubled-github-${new Date().toISOString().replace(/[:.]/g, "-")}`)),
    exists: deps.exists ?? existsSync,
    readdir: deps.readdir ?? readdirSync,
    stat: deps.stat ?? statSync,
    execFile: deps.execFile ?? (async (file, args) => { await execFileAsync(file, args); }),
    copyDir: deps.copyDir ?? (async (from, to) => { await cp(from, to, { recursive: true, force: false, errorOnExist: false }); }),
    moveDir: deps.moveDir ?? (async (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      await execFileAsync("mv", [from, to]);
    }),
  };
}

function findRepoDirs(doubledRoot: string, deps: Required<FixSessionsDeps>): string[] {
  if (!deps.exists(doubledRoot)) return [];
  const results: string[] = [];
  let owners: string[];
  try { owners = deps.readdir(doubledRoot); } catch { return []; }
  for (const owner of owners) {
    const ownerDir = join(doubledRoot, owner);
    try { if (!deps.stat(ownerDir).isDirectory()) continue; } catch { continue; }
    let repos: string[];
    try { repos = deps.readdir(ownerDir); } catch { continue; }
    for (const repo of repos) {
      const repoDir = join(ownerDir, repo);
      try { if (deps.stat(repoDir).isDirectory()) results.push(repoDir); } catch { /* skip */ }
    }
  }
  return results;
}

function countJsonlSessions(dir: string, deps: Required<FixSessionsDeps>): number {
  if (!deps.exists(dir)) return 0;
  let count = 0;
  const visit = (path: string) => {
    let entries: string[];
    try { entries = deps.readdir(path); } catch { return; }
    for (const entry of entries) {
      if (entry.includes("subagents")) continue;
      const full = join(path, entry);
      let st: { isDirectory(): boolean; isFile(): boolean };
      try { st = deps.stat(full); } catch { continue; }
      if (st.isDirectory()) visit(full);
      else if (st.isFile() && entry.endsWith(".jsonl")) count++;
    }
  };
  visit(dir);
  return count;
}

function quarantinePath(root: string, doubled: string): string {
  const rel = doubled.replace(/^\/+/, "").replace(/[/:]/g, "__");
  return join(root, rel);
}

function githubSlug(canonical: string): string {
  const marker = "/github.com/";
  const idx = canonical.toLowerCase().lastIndexOf(marker);
  if (idx >= 0) return `github.com/${canonical.slice(idx + marker.length)}`;
  return canonical;
}

function summarizePairs(pairs: FixSessionsPair[]): string {
  const counts: Record<FixSessionsAction, number> = { remap: 0, "clone+remap": 0, "cleanup-only": 0 };
  for (const pair of pairs) counts[pair.action]++;
  return `${pairs.length} doubled dir${pairs.length === 1 ? "" : "s"}; remap=${counts.remap}; clone+remap=${counts["clone+remap"]}; cleanup-only=${counts["cleanup-only"]}`;
}
