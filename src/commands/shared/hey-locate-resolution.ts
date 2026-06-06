import { existsSync } from "fs";
import { isAbsolute, join, resolve, sep } from "path";
import type { MawConfig } from "../../config";
import { getGhqRoot } from "../../config/ghq-root";
import { ghqFind } from "../../core/ghq";
import type { Session } from "../../core/runtime/find-window";
import { loadManifestCached, type OracleManifestEntry } from "../../lib/oracle-manifest";
import { loadFleetEntries, type FleetEntry } from "./fleet-load";

type LocalResolveResult = { type: "local" | "self-node"; target: string } | null;

export interface HeyLocateResolution {
  result: LocalResolveResult;
  repoPath: string | null;
  crossNodeBlocked: boolean;
}

export interface HeyLocateResolutionDeps {
  ghqFind?: typeof ghqFind;
  loadManifest?: () => OracleManifestEntry[];
  loadFleetEntries?: () => FleetEntry[];
  getGhqRoot?: typeof getGhqRoot;
  existsSync?: typeof existsSync;
}

type SessionWithCwd = Session & { windows: Array<Session["windows"][number] & { cwd?: string }> };

function normalizeOracleName(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\d+-/, "")
    .replace(/-oracle$/, "");
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function repoFromFleetValue(value: string, ghqRoot: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (isAbsolute(trimmed)) return [trimmed];
  if (trimmed.startsWith("github.com/")) return [join(ghqRoot, trimmed)];
  if (/^[^/]+\/[^/]+(?:\/.*)?$/.test(trimmed)) return [join(ghqRoot, "github.com", trimmed), join(ghqRoot, trimmed)];
  return [join(ghqRoot, trimmed)];
}

function entryNameMatches(query: string, entry: OracleManifestEntry): boolean {
  const wanted = normalizeOracleName(query);
  return [entry.name, entry.window, entry.session]
    .filter(Boolean)
    .some((name) => normalizeOracleName(name) === wanted);
}

function fleetEntryMatches(query: string, entry: FleetEntry): boolean {
  const wanted = normalizeOracleName(query);
  const names = [
    entry.file.replace(/\.json$/, ""),
    entry.groupName,
    entry.session?.name,
    ...(entry.session?.windows ?? []).map((w) => w.name),
  ];
  return names.some((name) => normalizeOracleName(name) === wanted);
}

function resolveLocalPathCandidates(candidates: string[], exists: typeof existsSync): string[] {
  return unique(candidates).filter((candidate) => {
    try {
      // Keep manifest-provided absolute paths even when the repo is currently
      // absent: the caller still needs the exact path for the no-live warning,
      // and receiver inbox persistence will report its own availability.
      return isAbsolute(candidate) || exists(candidate);
    } catch {
      return isAbsolute(candidate);
    }
  });
}

export async function locateRepoPathsForBareHey(
  query: string,
  deps: HeyLocateResolutionDeps = {},
): Promise<string[]> {
  const find = deps.ghqFind ?? ghqFind;
  const loadManifest = deps.loadManifest ?? loadManifestCached;
  const loadFleet = deps.loadFleetEntries ?? loadFleetEntries;
  const root = (deps.getGhqRoot ?? getGhqRoot)();
  const exists = deps.existsSync ?? existsSync;
  const paths: string[] = [];

  try {
    paths.push(await find(`/${query}-oracle`) ?? "");
    paths.push(await find(`/${query}`) ?? "");
  } catch {
    // Best effort; manifest/fleet may still know the path.
  }

  try {
    const entry = loadManifest().find((candidate) => entryNameMatches(query, candidate));
    if (entry?.localPath) paths.push(entry.localPath);
    if (entry?.repo) paths.push(join(root, "github.com", entry.repo), join(root, entry.repo));
  } catch {
    // Manifest lookup must not break hey delivery.
  }

  try {
    for (const entry of loadFleet()) {
      if (!fleetEntryMatches(query, entry)) continue;
      for (const win of entry.session?.windows ?? []) {
        paths.push(...repoFromFleetValue(win.repo, root));
      }
    }
  } catch {
    // Fleet lookup is advisory for locate-style resolution.
  }

  return resolveLocalPathCandidates(paths, exists);
}

function sameOrInside(candidate: string, repoPath: string): boolean {
  const cwd = resolve(candidate);
  const repo = resolve(repoPath);
  return cwd === repo || cwd.startsWith(`${repo}${sep}`);
}

function targetForWindow(session: SessionWithCwd, window: SessionWithCwd["windows"][number]): string {
  return `${session.name}:${window.name || window.index}`;
}

export function resolveLiveSessionByRepoPath(
  repoPath: string,
  sessions: Session[],
): LocalResolveResult {
  for (const session of sessions as SessionWithCwd[]) {
    for (const window of session.windows ?? []) {
      if (window.cwd && sameOrInside(window.cwd, repoPath)) {
        return { type: "local", target: targetForWindow(session, window) };
      }
    }
  }
  return null;
}

/**
 * `maw hey <bare>` locate-style resolver for #2056.
 *
 * Bare names stay local-only: a manifest/config remote node hit never becomes a
 * peer route here. We only use locate-style sources to find a local repo path,
 * then map that path to an active local tmux window or queue inbox-only.
 */
export async function resolveBareHeyByLocatePath(
  query: string,
  config: Pick<MawConfig, "node">,
  sessions: Session[],
  deps: HeyLocateResolutionDeps = {},
): Promise<HeyLocateResolution> {
  const repoPaths = await locateRepoPathsForBareHey(query, deps);
  const repoPath = repoPaths[0] ?? null;
  if (!repoPath) return { result: null, repoPath: null, crossNodeBlocked: false };

  const result = resolveLiveSessionByRepoPath(repoPath, sessions);
  const selfNode = config.node ?? "local";
  let crossNodeBlocked = false;
  try {
    const manifestEntry = (deps.loadManifest ?? loadManifestCached)().find((entry) => entryNameMatches(query, entry));
    crossNodeBlocked = Boolean(manifestEntry?.node && manifestEntry.node !== selfNode && manifestEntry.node !== "local");
  } catch {
    crossNodeBlocked = false;
  }

  return { result, repoPath, crossNodeBlocked };
}
