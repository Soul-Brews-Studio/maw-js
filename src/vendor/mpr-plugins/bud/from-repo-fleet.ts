/**
 * Fleet-entry registration for `maw bud --from-repo` (#588).
 *
 * Only module that writes fleet entries for the from-repo flow. Tests can
 * `mock.module("./from-repo-fleet", …)` to assert wiring without
 * writing to the user fleet.
 *
 * Design: docs/bud/from-repo-impl.md section (h).
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { execFileSync } from "child_process";
import { fleetDirForWrite, loadFleetEntries, type FleetEntry } from "maw-js/commands/shared/fleet-load";

/** Parsed `org/repo` slug from a remote URL. */
export interface RepoSlug {
  org: string;
  repo: string;
}

/**
 * Extract `org/repo` from a git remote URL.
 *  - `git@github.com:org/repo.git` → `{org, repo}`
 *  - `https://github.com/org/repo(.git)?` → `{org, repo}`
 * Returns null if the URL doesn't match a recognized shape.
 */
export function parseRemoteUrl(url: string): RepoSlug | null {
  const trimmed = url.trim();
  let m = trimmed.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return { org: m[1], repo: m[2] };
}

/**
 * Read `git -C <target> remote get-url origin`; returns null on any failure.
 *
 * Uses execFileSync + argv to avoid shell interpretation of `target`
 * (js/indirect-command-line-injection, #474). Matches the pattern proven
 * in view/impl.ts (#604) and wake.ts attachToSession.
 */
export function readOriginRemote(target: string): string | null {
  try {
    return execFileSync("git", ["-C", target, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolve org/repo for the target; falls back to `<unknown>/<basename>`. */
export function resolveSlug(target: string): RepoSlug {
  const url = readOriginRemote(target);
  if (url) {
    const parsed = parseRemoteUrl(url);
    if (parsed) return parsed;
  }
  return { org: "<unknown>", repo: basename(target) };
}

/** Absolute source path for an entry, falling back to the current write dir. */
function fleetEntryPath(entry: Pick<FleetEntry, "file" | "path">): string {
  return entry.path ?? join(fleetDirForWrite(), entry.file);
}

/** Find the next NN prefix by scanning existing fleet entries across read roots. */
function nextFleetNum(entries: FleetEntry[] = loadFleetEntries()): number {
  return entries.reduce((max, entry) => Math.max(max, entry.num), 0) + 1;
}

/** Find an existing fleet file for this stem (matches `NN-<stem>.json`). */
function findExistingForStem(stem: string, entries: FleetEntry[] = loadFleetEntries()): FleetEntry | null {
  return entries.find((entry) => entry.file.endsWith(`-${stem}.json`)) ?? null;
}

export interface RegisterFleetOpts {
  stem: string;
  /** Local target dir — used to read git remote for slug. */
  target: string;
  /** Optional parent stem — sets `budded_from` + `budded_at`. */
  parent?: string;
}

export interface RegisterFleetResult {
  file: string;
  created: boolean;
  slug: RepoSlug;
}

/**
 * Idempotent fleet registration. If `<NN>-<stem>.json` already exists,
 * leave it alone (and merge lineage if `--from` adds it to a previously
 * lineage-less entry). Otherwise create a new `<NN>-<stem>.json`.
 */
export function registerFleetEntry(opts: RegisterFleetOpts): RegisterFleetResult {
  const slug = resolveSlug(opts.target);
  const entries = loadFleetEntries();
  const existing = findExistingForStem(opts.stem, entries);
  if (existing) {
    const path = fleetEntryPath(existing);
    const cfg = JSON.parse(readFileSync(path, "utf-8"));
    let updated = false;
    if (opts.parent && !cfg.budded_from) {
      cfg.budded_from = opts.parent;
      cfg.budded_at = new Date().toISOString();
      updated = true;
    }
    if (updated) writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    return { file: path, created: false, slug };
  }
  const num = nextFleetNum(entries);
  const padded = String(num).padStart(2, "0");
  const writeDir = fleetDirForWrite();
  mkdirSync(writeDir, { recursive: true });
  const file = join(writeDir, `${padded}-${opts.stem}.json`);
  const cfg: Record<string, unknown> = {
    name: `${padded}-${opts.stem}`,
    windows: [{ name: `${opts.stem}-oracle`, repo: `${slug.org}/${slug.repo}` }],
    sync_peers: [],
  };
  if (opts.parent) {
    cfg.budded_from = opts.parent;
    cfg.budded_at = new Date().toISOString();
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { file, created: true, slug };
}
