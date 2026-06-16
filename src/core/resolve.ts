import { ghqList } from "./ghq";
import { lstatSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { normalizeGhqRepos } from "./repo-discovery/ghq-normalize";

export type OracleRef = { owner: string; repo: string; path?: string };

export type ResolveResult =
  | { kind: "exact"; oracle: OracleRef }
  | { kind: "ambiguous"; candidates: OracleRef[] }
  | { kind: "not-found" };

export type ResolveOracleOptions = {
  nameSpace: "session" | "oracle" | "any";
  pwdHint?: { owner: string; repo: string };
  matchPolicy: "exact" | "prefix" | "substring";
  repos?: string[] | (() => Promise<string[]>);
};

export type PickOracleOptions = {
  stream?: Pick<NodeJS.WriteStream, "write">;
  reader?: NodeJS.ReadStream;
  now?: number;
  liveSessions?: Set<string>;
  getLastActivityMs?: (path: string) => number;
};

export type RankedOracleCandidate = OracleRef & {
  recommended: boolean;
  lastActivityMs: number;
  hasLiveSession: boolean;
};

type RankOracleOptions = {
  liveSessions?: Set<string>;
  now?: number;
  getLastActivityMs?: (path: string) => number;
};

function repoNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

function oracleRefFromPath(path: string): OracleRef | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const repo = parts.at(-1) ?? "";
  const owner = parts.at(-2) ?? "";
  if (!owner || !repo || !repo.toLowerCase().endsWith("-oracle")) return null;
  return { owner, repo, path };
}

function stripOracleSuffix(name: string): string {
  return name.replace(/-oracle$/i, "");
}

function stripNumericFleetPrefix(name: string): string {
  return name.replace(/^\d+-/, "");
}

function normalizedIntentNames(query: string): string[] {
  const raw = query.trim().toLowerCase();
  const withoutNumeric = stripNumericFleetPrefix(raw);
  return [...new Set([
    raw,
    stripOracleSuffix(raw),
    withoutNumeric,
    stripOracleSuffix(withoutNumeric),
  ].filter(Boolean))];
}

function refSlug(ref: OracleRef): string {
  return `${ref.owner}/${ref.repo}`;
}

function isSameRef(a: OracleRef, b: { owner: string; repo: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase();
}

function compareRefs(pwdHint?: { owner: string; repo: string }) {
  return (a: OracleRef, b: OracleRef): number => {
    if (pwdHint) {
      const ah = isSameRef(a, pwdHint) ? 0 : 1;
      const bh = isSameRef(b, pwdHint) ? 0 : 1;
      if (ah !== bh) return ah - bh;
    }
    return refSlug(a).localeCompare(refSlug(b));
  };
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function defaultGetLastActivityMs(path: string): number {
  let latest = 0;
  const root = normalizeRepoPath(path);

  const walk = (entry: string): void => {
    try {
      const stat = lstatSync(entry);
      const mtime = stat.mtimeMs;
      if (mtime > latest) latest = mtime;
      if (!stat.isDirectory()) return;
      const base = entry.split("/").pop() ?? "";
      if (base === ".git") return;
    } catch {
      return;
    }

    let childEntries: string[];
    try {
      childEntries = readdirSync(entry);
    } catch {
      return;
    }

    for (const child of childEntries) {
      if (child === ".git") continue;
      walk(join(entry, child));
    }
  };

  walk(root);
  return latest;
}

function rankOracleCandidatePath(ref: OracleRef, liveSessions: Set<string>): boolean {
  if (!ref.path) return false;
  const normalized = normalizeRepoPath(ref.path);
  return liveSessions.has(normalized);
}

function compareOracleCandidates(a: RankedOracleCandidate, b: RankedOracleCandidate): number {
  if (a.hasLiveSession !== b.hasLiveSession) return a.hasLiveSession ? -1 : 1;
  if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
  return refSlug(a).localeCompare(refSlug(b));
}

function relativeTimeFromMs(now: number, lastActivityMs: number): string {
  if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) return "never";
  const diffMs = Math.max(0, now - lastActivityMs);
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day > 0) return `${day}d ago`;
  if (hr > 0) return `${hr}h ago`;
  if (min > 0) return `${min}m ago`;
  return `${sec}s ago`;
}

export function rankOracleCandidates(
  candidates: OracleRef[],
  opts: RankOracleOptions = {},
): RankedOracleCandidate[] {
  const now = opts.now ?? Date.now();
  const liveSessions = opts.liveSessions
    ? new Set([...opts.liveSessions].map(normalizeRepoPath))
    : new Set<string>();
  const getLastActivityMs = opts.getLastActivityMs ?? defaultGetLastActivityMs;

  const ranked = candidates.map((candidate) => {
    const normalizedPath = candidate.path ? normalizeRepoPath(candidate.path) : null;
    const lastActivityMs = normalizedPath ? getLastActivityMs(normalizedPath) : 0;
    const hasLiveSession = normalizedPath ? liveSessions.has(normalizedPath) : false;
    return {
      ...candidate,
      path: normalizedPath ?? candidate.path,
      lastActivityMs,
      hasLiveSession,
      recommended: false,
    };
  });

  ranked.sort(compareOracleCandidates);
  return ranked.map((candidate, index) => ({
    ...candidate,
    recommended: index === 0,
  }));
}

function uniqueRefs(refs: OracleRef[]): OracleRef[] {
  const seen = new Set<string>();
  const out: OracleRef[] = [];
  for (const ref of refs) {
    const key = refSlug(ref).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function matchesRef(ref: OracleRef, query: string, matchPolicy: ResolveOracleOptions["matchPolicy"]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;

  const full = refSlug(ref).toLowerCase();
  const repo = ref.repo.toLowerCase();
  const bare = stripOracleSuffix(repo);
  const intents = normalizedIntentNames(q);

  if (q.includes("/")) {
    const [owner, repoPart] = q.split("/");
    if (!owner || !repoPart) return false;
    const wantedRepo = repoPart.endsWith("-oracle") ? repoPart : `${repoPart}-oracle`;
    if (matchPolicy === "exact") return full === `${owner}/${wantedRepo}`;
    if (ref.owner.toLowerCase() !== owner) return false;
    if (matchPolicy === "prefix") return repo.startsWith(wantedRepo) || bare.startsWith(repoPart);
    return repo.includes(repoPart) || bare.includes(repoPart);
  }

  if (matchPolicy === "exact") {
    return intents.includes(repo) || intents.includes(bare);
  }
  if (matchPolicy === "prefix") {
    return intents.some(intent => repo.startsWith(intent) || bare.startsWith(intent));
  }
  return intents.some(intent => repo.includes(intent) || bare.includes(intent) || intent.includes(bare));
}

async function readRepos(opts: ResolveOracleOptions): Promise<string[]> {
  const repos = Array.isArray(opts.repos)
    ? opts.repos
    : opts.repos
      ? await opts.repos()
      : await ghqList();
  return normalizeGhqRepos(repos);
}

/**
 * Resolve a user-supplied oracle name to local ghq candidates without hiding
 * ambiguity behind pwd-derived context. `pwdHint` only ranks candidates; it
 * never suppresses another matching owner/repo.
 */
export async function resolveOracle(query: string, opts: ResolveOracleOptions): Promise<ResolveResult> {
  if (opts.nameSpace === "session") return { kind: "not-found" };
  const refs = uniqueRefs((await readRepos(opts)).map(oracleRefFromPath).filter((r): r is OracleRef => !!r));
  const matches = refs
    .filter(ref => matchesRef(ref, query, opts.matchPolicy))
    .sort(compareRefs(opts.pwdHint));

  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length === 1) return { kind: "exact", oracle: matches[0]! };
  return { kind: "ambiguous", candidates: matches };
}

function readFromProvidedReader(reader: NodeJS.ReadStream): Promise<string> {
  return new Promise(resolve => {
    let text = "";
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes("\n")) cleanup();
    };
    const onEnd = () => cleanup();
    const cleanup = () => {
      reader.off("data", onData);
      reader.off("end", onEnd);
      resolve(text);
    };
    reader.on("data", onData);
    reader.on("end", onEnd);
    reader.resume?.();
  });
}

function readChoiceFromTty(): string {
  const { openSync, readSync, closeSync } = require("fs") as typeof import("fs");
  const fd = openSync("/dev/tty", "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.slice(0, n).toString();
  } finally {
    closeSync(fd);
  }
}

export async function pickOracle(candidates: OracleRef[], opts: PickOracleOptions = {}): Promise<OracleRef | null> {
  const stream = opts.stream ?? process.stdout;
  if (candidates.length === 0) return null;
  const ranked = rankOracleCandidates(candidates, {
    now: opts.now,
    liveSessions: opts.liveSessions,
    getLastActivityMs: opts.getLastActivityMs,
  });

  stream.write("\n  Wake which oracle?\n");
  const now = opts.now ?? Date.now();
  ranked.forEach((candidate, index) => {
    const label = candidate.recommended
      ? `    \x1b[33m⭐ recommended\x1b[0m`
      : "";
    const live = candidate.hasLiveSession
      ? `\x1b[32m● live session\x1b[0m`
      : "";
    const markers = [label, live].filter(Boolean);
    const markerText = markers.length ? `    ${markers.join(" \x1b[90m·\x1b[0m")} ` : "";
    const pathText = candidate.path ? ` \x1b[90m${candidate.path}\x1b[0m` : "";
    const activity = candidate.lastActivityMs
      ? `\x1b[90medited ${relativeTimeFromMs(now, candidate.lastActivityMs)}\x1b[0m`
      : "";
    const detail = [markerText, pathText].filter(Boolean).join(" ");
    const extra = [activity].filter(Boolean).join(" ");

    stream.write(`  \x1b[36m${index + 1}\x1b[0m) ${refSlug(candidate)}${detail ? ` ${detail}` : ""}`);
    if (extra) stream.write(`\n       ${extra}`);
    stream.write("\n");
  });
  stream.write("\n");
  stream.write(`  Select [1-${candidates.length}] (Enter = 1): `);

  let raw = "";
  try {
    raw = opts.reader ? await readFromProvidedReader(opts.reader) : readChoiceFromTty();
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return ranked[0] ?? null;
  const choice = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(choice) || choice < 1 || choice > candidates.length) return null;
  return ranked[choice - 1] ?? null;
}

export const _test = {
  oracleRefFromPath,
  repoNameFromPath,
  refSlug,
  normalizedIntentNames,
  rankOracleCandidates,
  _rankRelativeTime: relativeTimeFromMs,
};
