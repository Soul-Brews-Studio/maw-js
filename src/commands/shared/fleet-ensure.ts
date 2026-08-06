import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, relative, resolve, sep } from "path/posix";
import { getGhqRoot } from "../../config/ghq-root";
import { fleetDirForWrite, fleetDirsForRead, uniqueDirs } from "../../core/fleet/paths";
import { loadFleetEntries, type FleetEntry, type FleetWindow } from "./fleet-load";

export type FleetSessionCreatedBy = "maw wake" | "maw new" | string;

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface EnsureFleetSessionEntryInput {
  session: string;
  window: string;
  cwd?: string;
  createdBy: FleetSessionCreatedBy;
}

export type EnsureFleetSessionEntryResult =
  | { status: "created"; file: string; entry: FleetEntry }
  | { status: "updated"; file: string; entry: FleetEntry }
  | { status: "exists"; file: string; entry: FleetEntry }
  | { status: "skipped"; reason: string };

interface EnsureFleetSessionEntryDeps {
  fleetDirForWrite?: () => string;
  fleetDirsForRead?: () => string[];
  loadFleetEntries?: (dirs?: string[]) => FleetEntry[];
  getGhqRoot?: () => string;
  existsSync?: typeof existsSync;
  mkdirSync?: typeof mkdirSync;
  writeFileSync?: typeof writeFileSync;
  now?: () => Date;
}

function isSafeFleetSessionName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`));
}

type RepoFromCwdResult =
  | { repo: string }
  | { repo: null; reason: string; archiveCopy?: boolean };

function isArchivedSegment(segment: string): boolean {
  return /^_?\.?archive(?:d)?$/i.test(segment);
}

function repoFromCwdResult(cwd: string | undefined, ghqRoot: string): RepoFromCwdResult {
  if (!cwd) return { repo: null, reason: "missing cwd" };
  const resolvedCwd = resolve(toPosixPath(cwd));
  const posixGhq = toPosixPath(ghqRoot);
  const candidates: Array<{ root: string; segments: number }> = [
    { root: resolve(posixGhq), segments: 3 },
    { root: resolve(posixGhq, "github.com"), segments: 2 },
  ];
  for (const { root, segments } of candidates) {
    if (!isInside(root, resolvedCwd)) continue;
    const parts = relative(root, resolvedCwd).split(sep);
    if (parts.length < segments || parts[0] === "..") continue;
    const repoParts = parts.slice(0, segments);
    if (repoParts.some(isArchivedSegment)) {
      return {
        repo: null,
        archiveCopy: true,
        reason: `refusing to register archive copy: ${cwd}`,
      };
    }
    // Canonical fleet repo refs come from $(ghq root)/github.com/<org>/<repo>.
    // A cwd under $(ghq root)/_archive/... can otherwise look like a valid
    // three-segment ghq repo and poison windows[].repo with _archive/... .
    if (segments === 3 && repoParts[0] !== "github.com") {
      return { repo: null, reason: `cwd is outside canonical ghq host root: ${cwd}` };
    }
    return { repo: repoParts.join("/") };
  }
  return { repo: null, reason: `cwd is outside ghq root: ${cwd}` };
}

function repoFromCwd(cwd: string | undefined, ghqRoot: string): string | null {
  return repoFromCwdResult(cwd, ghqRoot).repo;
}

function fleetFileNameForSession(session: string): string {
  return `${session}.json`;
}

function buildEntry(file: string, path: string, session: any): FleetEntry {
  const match = file.match(/^(\d+)-(.+)\.json$/);
  return {
    file,
    path,
    num: match ? parseInt(match[1]!, 10) : 0,
    groupName: match ? match[2]! : file.replace(/\.json$/i, ""),
    session,
  };
}

function windowExists(windows: FleetWindow[] | undefined, name: string): boolean {
  return (windows || []).some(w => w.name.toLowerCase() === name.toLowerCase());
}

/**
 * Ensure a newly-created top-level tmux session has a minimal fleet registry
 * file. This is intentionally creation-path only; callers must not use it as a
 * silent migration for already-live sessions discovered after the fact.
 */
export function ensureFleetSessionEntry(
  input: EnsureFleetSessionEntryInput,
  deps: EnsureFleetSessionEntryDeps = {},
): EnsureFleetSessionEntryResult {
  const session = input.session.trim();
  const window = input.window.trim();
  if (!isSafeFleetSessionName(session)) return { status: "skipped", reason: `unsafe session name: ${input.session}` };
  if (!window) return { status: "skipped", reason: "missing initial window" };

  const readDirs = uniqueDirs((deps.fleetDirsForRead ?? fleetDirsForRead)().map(toPosixPath));
  const entries = (deps.loadFleetEntries ?? loadFleetEntries)(readDirs);
  const existing = entries.find(e => e.session?.name === session || e.file === fleetFileNameForSession(session));
  const ghqRoot = toPosixPath((deps.getGhqRoot ?? getGhqRoot)());
  const repoResult = repoFromCwdResult(input.cwd, ghqRoot);
  const repo = repoResult.repo;
  if (!repo) {
    if (repoResult.archiveCopy) {
      console.warn(`\x1b[33m⚠\x1b[0m ${repoResult.reason}`);
    }
    return { status: "skipped", reason: repoResult.reason };
  }

  if (existing?.path) {
    const windows = existing.session.windows || [];
    if (windowExists(windows, window)) return { status: "exists", file: existing.path, entry: existing };
    const nextSession = {
      ...existing.session,
      windows: [...windows, { name: window, repo }],
    };
    const nextEntry = { ...existing, session: nextSession };
    (deps.writeFileSync ?? writeFileSync)(existing.path, JSON.stringify(nextSession, null, 2) + "\n", "utf-8");
    return { status: "updated", file: existing.path, entry: nextEntry };
  }

  const writeDir = toPosixPath((deps.fleetDirForWrite ?? fleetDirForWrite)());
  (deps.mkdirSync ?? mkdirSync)(writeDir, { recursive: true });
  const file = fleetFileNameForSession(session);
  const path = join(writeDir, file);
  if ((deps.existsSync ?? existsSync)(path)) {
    // Race/duplicate guard: do not overwrite an unknown file. Let the next
    // explicit drift doctor reconcile it if content is malformed.
    return { status: "skipped", reason: `fleet file already exists: ${path}` };
  }

  const createdAt = (deps.now ?? (() => new Date()))().toISOString();
  const fleetSession = {
    name: session,
    created_at: createdAt,
    created_by: input.createdBy,
    auto_registered: true,
    windows: [{ name: window, repo }],
  };
  (deps.writeFileSync ?? writeFileSync)(path, JSON.stringify(fleetSession, null, 2) + "\n", "utf-8");
  return { status: "created", file: path, entry: buildEntry(file, path, fleetSession) };
}

export const _test = { repoFromCwd, repoFromCwdResult, isSafeFleetSessionName };
