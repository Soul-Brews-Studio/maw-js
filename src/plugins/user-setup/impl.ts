import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { execSync } from "child_process";

export const USER_SETUP_AUDIT_USAGE = "usage: maw user-setup projects audit --json";
export const USER_SETUP_USAGE = "usage: maw user-setup [--dry-run] or maw user-setup projects audit --json";

export type PathConfidence = "exact" | "probable" | "ambiguous" | "unknown";

export interface PathFinding {
  encoded: string;
  inferred?: string;
  confidence: PathConfidence;
  evidence: string[];
}

export interface RepoFinding {
  owner?: string;
  name?: string;
  remote?: string;
}

export interface WorktreeFinding {
  detected: boolean;
  alive?: boolean;
  evidence: string[];
}

export interface FileFinding {
  name: string;
  sizeBytes: number;
  lastModified: string | null;
}

export interface UserSetupAuditEntry {
  encoded: string;
  path: PathFinding;
  sizeBytes: number;
  sessionCount: number;
  lastModified: string | null;
  sourceExists?: boolean;
  repo?: RepoFinding;
  worktree?: WorktreeFinding;
  largestFiles: FileFinding[];
  warnings: string[];
}

export interface UserSetupAuditResult {
  root: string;
  generatedAt: string;
  projectCount: number;
  totalSizeBytes: number;
  entries: UserSetupAuditEntry[];
  warnings: string[];
}

export interface DuplicatePathFinding {
  inferred: string;
  encoded: string[];
}

export interface UserSetupPrunePlan {
  root: string;
  generatedAt: string;
  dryRun: boolean;
  staleProjectDirs: UserSetupAuditEntry[];
  orphanSessionFiles: FileFinding[];
  duplicateEncodedPaths: DuplicatePathFinding[];
  warnings: string[];
}

function isWorktreeDerivedProject(encoded: string): boolean {
  return encoded.includes("-wt-") || encoded.includes("-agents-");
}

function isSafePruneCandidate(entry: UserSetupAuditEntry): boolean {
  return isWorktreeDerivedProject(entry.encoded)
    && entry.sessionCount === 0
    && entry.sourceExists === false;
}

type DirentLike = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
type StatLike = { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
type ExecSyncString = (command: string, options?: { encoding: BufferEncoding; timeout?: number; maxBuffer?: number }) => string;

export interface UserSetupAuditDeps {
  now?: () => Date;
  homeDir?: () => string;
  cwd?: () => string;
  existsSync?: (path: string) => boolean;
  statSync?: (path: string) => StatLike;
  readdirSync?: (path: string, options?: { withFileTypes?: boolean }) => string[] | DirentLike[];
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  realpathSync?: (path: string) => string;
  execSync?: ExecSyncString;
  maxLargestFiles?: number;
  projectsRoot?: string;
}

interface ScanSummary {
  sizeBytes: number;
  lastModifiedMs: number | null;
  sessionCount: number;
  largestFiles: FileFinding[];
  warnings: string[];
}

const DEFAULT_LARGEST_FILES = 5;

function depsWithDefaults(deps: UserSetupAuditDeps): Required<Omit<UserSetupAuditDeps, "projectsRoot">> & { projectsRoot?: string } {
  return {
    now: deps.now ?? (() => new Date()),
    homeDir: deps.homeDir ?? homedir,
    cwd: deps.cwd ?? (() => process.cwd()),
    existsSync: deps.existsSync ?? existsSync,
    statSync: deps.statSync ?? statSync,
    readdirSync: deps.readdirSync ?? ((path, options) => readdirSync(path, options as any) as any),
    readFileSync: deps.readFileSync ?? ((path, encoding) => readFileSync(path, encoding)),
    realpathSync: deps.realpathSync ?? realpathSync,
    execSync: deps.execSync ?? (execSync as ExecSyncString),
    maxLargestFiles: deps.maxLargestFiles ?? DEFAULT_LARGEST_FILES,
    projectsRoot: deps.projectsRoot,
  };
}

function isoFromMs(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function encodeClaudeProjectPath(path: string): string {
  const absolute = resolve(path);
  const normalized = absolute.replace(/\\/g, "/");
  const withDriveMarker = normalized.replace(/^([A-Za-z]):\//, "/$1--");
  return withDriveMarker.replace(/^\//, "-").replace(/\//g, "-");
}

/** Claude's project-dir encoding is lossy for hyphenated path segments; never treat this reversal as exact by itself. */
export function inferPathFromEncoded(encoded: string, deps: UserSetupAuditDeps = {}): PathFinding {
  const d = depsWithDefaults(deps);
  const evidence: string[] = [];
  if (!encoded.startsWith("-")) {
    return { encoded, confidence: "unknown", evidence: ["encoded-name-does-not-look-like-absolute-claude-project-dir"] };
  }

  let inferred = encoded.replace(/^-/, "/");
  inferred = inferred.replace(/^\/([A-Za-z])--/, "$1:/");
  inferred = inferred.replace(/-/g, "/");
  evidence.push("dash-decoded-from-claude-project-dir");

  let exists = false;
  try { exists = d.existsSync(inferred); } catch { exists = false; }
  if (exists) evidence.push("inferred-path-exists");

  // Exact only when an independent runtime path re-encodes to this directory name.
  // That avoids promoting lossy dash reversal to truth while allowing the active cwd
  // to anchor confidence when it is the current project.
  try {
    const cwd = d.cwd();
    if (cwd && encodeClaudeProjectPath(cwd) === encoded) {
      evidence.push("current-working-directory-reencodes-to-project-dir");
      return { encoded, inferred: resolve(cwd), confidence: "exact", evidence };
    }
  } catch { /* ignore cwd evidence failures */ }

  return { encoded, inferred, confidence: exists ? "probable" : "ambiguous", evidence };
}

function isDirentDirectory(entry: DirentLike): boolean {
  return entry.isDirectory() || Boolean(entry.isSymbolicLink?.());
}

function readDirents(path: string, deps: ReturnType<typeof depsWithDefaults>): DirentLike[] {
  const entries = deps.readdirSync(path, { withFileTypes: true }) as Array<string | DirentLike>;
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    const full = join(path, entry);
    const st = deps.statSync(full);
    return {
      name: entry,
      isDirectory: () => st.isDirectory(),
      isFile: () => st.isFile(),
      isSymbolicLink: () => Boolean(st.isSymbolicLink?.()),
    };
  });
}

function addLargest(largest: FileFinding[], file: FileFinding, max: number): void {
  largest.push(file);
  largest.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  if (largest.length > max) largest.length = max;
}

function scanProjectDir(root: string, dirPath: string, deps: ReturnType<typeof depsWithDefaults>): ScanSummary {
  const warnings: string[] = [];
  const largestFiles: FileFinding[] = [];
  let sizeBytes = 0;
  let lastModifiedMs: number | null = null;
  let sessionCount = 0;

  function visit(path: string): void {
    let st: StatLike;
    try { st = deps.statSync(path); }
    catch (e: unknown) {
      warnings.push(`stat failed for ${path.slice(root.length + 1) || basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    lastModifiedMs = Math.max(lastModifiedMs ?? 0, st.mtimeMs || 0);
    if (st.isFile()) {
      sizeBytes += st.size || 0;
      const rel = path.startsWith(root + sep) ? path.slice(root.length + 1) : basename(path);
      if (rel.endsWith(".jsonl")) sessionCount += 1;
      addLargest(largestFiles, { name: rel, sizeBytes: st.size || 0, lastModified: isoFromMs(st.mtimeMs || null) }, deps.maxLargestFiles);
      return;
    }
    if (!st.isDirectory()) return;

    let entries: DirentLike[];
    try { entries = readDirents(path, deps); }
    catch (e: unknown) {
      warnings.push(`read failed for ${path.slice(root.length + 1) || basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const entry of entries) visit(join(path, entry.name));
  }

  visit(dirPath);
  return { sizeBytes, lastModifiedMs, sessionCount, largestFiles, warnings };
}

function normalizeRemote(remote: string): string {
  return remote.trim()
    .replace(/^(ssh:\/\/)?git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/:/, "/")
    .replace(/\.git$/, "");
}

function parseRepo(remote: string): RepoFinding {
  const normalized = normalizeRemote(remote);
  const parts = normalized.split("/").filter(Boolean);
  const githubIdx = parts.findIndex(p => p === "github.com");
  const owner = githubIdx >= 0 ? parts[githubIdx + 1] : parts.at(-2);
  const name = githubIdx >= 0 ? parts[githubIdx + 2] : parts.at(-1);
  return { remote: normalized, ...(owner ? { owner } : {}), ...(name ? { name } : {}) };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function detectRepo(path: PathFinding, deps: ReturnType<typeof depsWithDefaults>): RepoFinding | undefined {
  if (!path.inferred || (path.confidence !== "exact" && path.confidence !== "probable")) return undefined;
  try {
    if (!deps.existsSync(path.inferred)) return undefined;
    const remote = deps.execSync(`git -C ${shellQuote(path.inferred)} remote get-url origin 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 1500,
      maxBuffer: 64 * 1024,
    }).trim();
    return remote ? parseRepo(remote) : undefined;
  } catch { return undefined; }
}

function detectWorktree(encoded: string, path: PathFinding, deps: ReturnType<typeof depsWithDefaults>): WorktreeFinding {
  const evidence: string[] = [];
  const candidates = [encoded, path.inferred ?? ""].filter(Boolean);
  if (candidates.some(v => /(?:^|[\/.-])wt[-_]/i.test(v) || /[\/]agents[\/]/i.test(v) || /worktree/i.test(v))) {
    evidence.push("path-shape-suggests-worktree");
  }

  let alive: boolean | undefined;
  if (path.inferred && (path.confidence === "exact" || path.confidence === "probable")) {
    try {
      if (deps.existsSync(path.inferred)) {
        const raw = deps.execSync(`git -C ${shellQuote(path.inferred)} worktree list --porcelain 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 1500,
          maxBuffer: 256 * 1024,
        });
        const realInferred = safeRealpath(path.inferred, deps);
        const listed = raw.split("\n").some(line => {
          if (!line.startsWith("worktree ")) return false;
          const listedPath = line.slice("worktree ".length).trim();
          return safeRealpath(listedPath, deps) === realInferred;
        });
        if (listed) {
          alive = true;
          evidence.push("git-worktree-list-confirms-path");
        } else if (raw.trim()) {
          alive = false;
          evidence.push("git-worktree-list-did-not-include-path");
        }
      }
    } catch { /* not a git worktree, or git unavailable */ }
  }

  return { detected: evidence.length > 0, ...(alive === undefined ? {} : { alive }), evidence };
}

function safeRealpath(path: string, deps: ReturnType<typeof depsWithDefaults>): string {
  try { return deps.realpathSync(path); } catch { return resolve(path); }
}

export async function auditClaudeProjects(deps: UserSetupAuditDeps = {}): Promise<UserSetupAuditResult> {
  const d = depsWithDefaults(deps);
  const root = d.projectsRoot ?? process.env.MAW_CLAUDE_PROJECTS_DIR ?? join(d.homeDir(), ".claude", "projects");
  const warnings: string[] = [];
  const entries: UserSetupAuditEntry[] = [];

  let projectDirs: DirentLike[];
  try {
    projectDirs = readDirents(root, d).filter(isDirentDirectory);
  } catch (e: unknown) {
    warnings.push(`cannot read Claude projects dir ${root}: ${e instanceof Error ? e.message : String(e)}`);
    return {
      root,
      generatedAt: d.now().toISOString(),
      projectCount: 0,
      totalSizeBytes: 0,
      entries: [],
      warnings,
    };
  }

  for (const dirent of projectDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const encoded = dirent.name;
    const dirPath = join(root, encoded);
    const path = inferPathFromEncoded(encoded, d);
    const scan = scanProjectDir(dirPath, dirPath, d);
    const warningsForEntry = [...scan.warnings];
    if (path.confidence === "ambiguous" || path.confidence === "unknown") warningsForEntry.push(`path confidence is ${path.confidence}`);
    if (scan.sessionCount === 0) warningsForEntry.push("no JSONL sessions found");

    let sourceExists: boolean | undefined;
    if (path.inferred) {
      try { sourceExists = d.existsSync(path.inferred); } catch { sourceExists = false; }
    }

    const repo = detectRepo(path, d);
    const worktree = detectWorktree(encoded, path, d);
    entries.push({
      encoded,
      path,
      sizeBytes: scan.sizeBytes,
      sessionCount: scan.sessionCount,
      lastModified: isoFromMs(scan.lastModifiedMs),
      ...(sourceExists === undefined ? {} : { sourceExists }),
      ...(repo ? { repo } : {}),
      worktree,
      largestFiles: scan.largestFiles,
      warnings: warningsForEntry,
    });
  }

  const totalSizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    root,
    generatedAt: d.now().toISOString(),
    projectCount: entries.length,
    totalSizeBytes,
    entries,
    warnings,
  };
}

function rootSessionFiles(root: string, deps: ReturnType<typeof depsWithDefaults>): FileFinding[] {
  let entries: DirentLike[];
  try { entries = readDirents(root, deps); }
  catch { return []; }

  const files: FileFinding[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = join(root, entry.name);
    try {
      const st = deps.statSync(full);
      files.push({ name: entry.name, sizeBytes: st.size || 0, lastModified: isoFromMs(st.mtimeMs || null) });
    } catch {
      files.push({ name: entry.name, sizeBytes: 0, lastModified: null });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function duplicateInferredPaths(entries: UserSetupAuditEntry[]): DuplicatePathFinding[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const inferred = entry.path.inferred;
    if (!inferred) continue;
    const list = groups.get(inferred) ?? [];
    list.push(entry.encoded);
    groups.set(inferred, list);
  }
  return [...groups.entries()]
    .filter(([, encoded]) => encoded.length > 1)
    .map(([inferred, encoded]) => ({ inferred, encoded: encoded.sort() }))
    .sort((a, b) => a.inferred.localeCompare(b.inferred));
}

export async function planUserSetupPrune(
  opts: { dryRun?: boolean } = {},
  deps: UserSetupAuditDeps = {},
): Promise<UserSetupPrunePlan> {
  const d = depsWithDefaults(deps);
  const audit = await auditClaudeProjects(deps);
  // Noah/m5 real-data rule: only prune empty worktree-derived Claude project dirs.
  // Observed shape: ~370 dirs, ~167 worktree-derived, ~86 empty/prune-able, ~81
  // with JSONL memory. Never prune main repo dirs or any dir with *.jsonl.
  const staleProjectDirs = audit.entries
    .filter(isSafePruneCandidate)
    .sort((a, b) => a.encoded.localeCompare(b.encoded));
  const orphanSessionFiles = rootSessionFiles(audit.root, d);
  const duplicateEncodedPaths = duplicateInferredPaths(audit.entries);

  return {
    root: audit.root,
    generatedAt: audit.generatedAt,
    dryRun: opts.dryRun !== false,
    staleProjectDirs,
    orphanSessionFiles,
    duplicateEncodedPaths,
    warnings: audit.warnings,
  };
}

export function renderUserSetupPlan(plan: UserSetupPrunePlan): string {
  const lines = [
    `maw user-setup ${plan.dryRun ? "dry-run " : ""}audit`,
    `root: ${plan.root}`,
    `safe prune candidates: ${plan.staleProjectDirs.length}`,
    `orphan session files: ${plan.orphanSessionFiles.length}`,
    `duplicate encoded paths: ${plan.duplicateEncodedPaths.length}`,
  ];

  if (plan.staleProjectDirs.length) {
    lines.push("", "safe prune candidates:");
    for (const entry of plan.staleProjectDirs) {
      lines.push(`  - ${entry.encoded}${entry.path.inferred ? ` -> ${entry.path.inferred}` : ""}`);
      lines.push("    why: worktree-derived name (-wt-/-agents-), 0 JSONL sessions, decoded path missing");
    }
  }
  if (plan.orphanSessionFiles.length) {
    lines.push("", "orphan session files:");
    for (const file of plan.orphanSessionFiles) lines.push(`  - ${file.name} (${file.sizeBytes} bytes)`);
  }
  if (plan.duplicateEncodedPaths.length) {
    lines.push("", "duplicate encoded paths:");
    for (const group of plan.duplicateEncodedPaths) lines.push(`  - ${group.inferred}: ${group.encoded.join(", ")}`);
  }
  if (plan.warnings.length) lines.push("", "warnings:", ...plan.warnings.map(w => `  - ${w}`));

  const pruneCount = plan.staleProjectDirs.length + plan.orphanSessionFiles.length;
  lines.push(
    "",
    pruneCount
      ? "prune offer: archive candidates are listed above; rerun after review when prune execution is enabled."
      : "prune offer: nothing to prune.",
  );
  return lines.join("\n");
}
