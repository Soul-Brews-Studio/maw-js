import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "fs";
import { execSync } from "child_process";
import { join, normalize, resolve } from "path";
import type { MawConfig } from "../../../config/types";
import { loadConfig as realLoadConfig } from "../../../config";
import type { ClaudeSession } from "../../../core/fleet/claude-sessions";
import { listClaudeSessions as realListClaudeSessions } from "../../../core/fleet/claude-sessions";
import type { OracleManifestEntry } from "../../../lib/oracle-manifest";
import { loadManifest as realLoadManifest } from "../../../lib/oracle-manifest";

export interface CliHelperOptions {
  json?: boolean;
}

export interface CliCommandDeps {
  loadManifest?: () => OracleManifestEntry[];
  loadConfig?: () => Partial<MawConfig>;
  listClaudeSessions?: () => Promise<ClaudeSession[]>;
  ghqFindSync?: (suffix: string) => string | null;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
}

export interface CliInvocation {
  target: string;
  oracle: string;
  sessionId: string;
  claudePath?: string;
  command: string;
  context: string;
  source: "manifest" | "config" | "claude-sessions";
}

interface CandidateTarget {
  raw: string;
  session?: string;
  window?: string;
  names: string[];
}

const DEFAULT_CLAUDE_BINARY = "claude";
const MAX_CONTEXT_CHARS = 1_600;

function uniq(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function stripNumericSessionPrefix(value: string): string {
  return value.replace(/^\d+-/, "");
}

export function stripOracleSuffix(value: string): string {
  return value.replace(/-oracle$/, "");
}

export function normalizeOracleName(value: string): string {
  const lower = value.trim().toLowerCase();
  return stripOracleSuffix(stripNumericSessionPrefix(lower));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}


function targetCandidates(target: string): CandidateTarget {
  const raw = target.trim();
  const names: string[] = [];
  let session: string | undefined;
  let window: string | undefined;

  const hasScope = raw.includes(":");
  if (hasScope) {
    const [left, ...rest] = raw.split(":");
    const right = rest.join(":");
    if (right) {
      if (/^\d+-/.test(left) || left.includes("-")) {
        session = left;
        window = right;
        names.push(normalizeOracleName(right));
        names.push(normalizeOracleName(left));
      } else {
        window = right;
        names.push(normalizeOracleName(right));
      }
    }
  }

  if (!hasScope) {
    names.push(normalizeOracleName(raw));
  }

  return { raw, session, window, names: uniq(names) };
}

function entryMatches(entry: OracleManifestEntry, target: CandidateTarget): boolean {
  const exacts = uniq([
    entry.name,
    entry.window,
    entry.session,
    entry.session && entry.window ? `${entry.session}:${entry.window}` : undefined,
  ]).map((value) => value.toLowerCase());

  const raw = target.raw.toLowerCase();
  if (exacts.includes(raw)) return true;
  if (target.session && entry.session?.toLowerCase() === target.session.toLowerCase()) return true;
  if (target.window && entry.window?.toLowerCase() === target.window.toLowerCase()) return true;
  return target.names.includes(normalizeOracleName(entry.name)) ||
    Boolean(entry.window && target.names.includes(normalizeOracleName(entry.window)));
}

function findEntry(manifest: OracleManifestEntry[], target: CandidateTarget): OracleManifestEntry | undefined {
  const exactName = manifest.find((entry) => target.names.includes(normalizeOracleName(entry.name)));
  if (exactName) return exactName;
  return manifest.find((entry) => entryMatches(entry, target));
}

function configSessionId(config: Partial<MawConfig>, names: string[]): string | undefined {
  const maps = [config.sessions, config.sessionIds];
  for (const map of maps) {
    if (!map) continue;
    for (const name of names) {
      const direct = map[name] || map[`${name}-oracle`];
      if (typeof direct === "string" && direct.length > 0) return direct;
    }
    for (const [pattern, value] of Object.entries(map)) {
      if (typeof value !== "string" || !value) continue;
      const normalizedPattern = normalizeOracleName(pattern.replace(/\*+/g, ""));
      if (names.some((name) => name === normalizedPattern || pattern === "*" || pattern === `${name}*` || pattern === `*${name}`)) {
        return value;
      }
    }
  }
  return undefined;
}

function repoSuffixes(entry: OracleManifestEntry | undefined, names: string[]): string[] {
  const suffixes: string[] = [];
  if (entry?.repo) suffixes.push(`/${entry.repo}`);
  for (const name of names) {
    suffixes.push(`/${name}-oracle`);
    suffixes.push(`/${name}`);
  }
  return uniq(suffixes);
}


function defaultGhqFindSync(suffix: string): string | null {
  const lower = suffix.replace(/\$$/, "").toLowerCase();
  try {
    const out = execSync("ghq list --full-path", { encoding: "utf-8", timeout: 2_000 });
    return out
      .split("\n")
      .filter(Boolean)
      .map((path) => path.replace(/\\/g, "/"))
      .find((path) => path.toLowerCase().endsWith(lower)) ?? null;
  } catch {
    return null;
  }
}

function resolveLocalPath(
  entry: OracleManifestEntry | undefined,
  names: string[],
  deps: Required<Pick<CliCommandDeps, "ghqFindSync" | "existsSync">>,
): string | undefined {
  if (entry?.localPath && deps.existsSync(entry.localPath)) return entry.localPath;
  for (const suffix of repoSuffixes(entry, names)) {
    const path = deps.ghqFindSync(suffix);
    if (path && deps.existsSync(path)) return path;
  }
  return undefined;
}

function sameOrChild(path: string, parent: string): boolean {
  const a = normalize(resolve(path));
  const b = normalize(resolve(parent));
  if (a === b || a.startsWith(`${b}/`)) return true;

  // Claude Code project directory names encode punctuation as path separators
  // (`github.com/Soul-Brews-Studio/foo-oracle` may appear as
  // `github/com/Soul/Brews/Studio/foo/oracle`). Compare a punctuation-free
  // fingerprint so `maw cli <oracle>` can still recover the active session id.
  const afp = pathFingerprint(a);
  const bfp = pathFingerprint(b);
  return afp === bfp || afp.startsWith(bfp);
}

function pathFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function sessionFromClaudeProjects(
  sessions: Promise<ClaudeSession[]>,
  localPath: string | undefined,
  entry: OracleManifestEntry | undefined,
): Promise<string | undefined> {
  if (!localPath && !entry?.repo) return undefined;
  const all = await sessions.catch(() => []);
  const matches = all.filter((session) => {
    if (localPath && sameOrChild(session.projectPath, localPath)) return true;
    if (entry?.repo && session.repo?.toLowerCase().endsWith(entry.repo.toLowerCase())) return true;
    return false;
  });
  matches.sort((a, b) => timestampMs(b.lastActivityAt) - timestampMs(a.lastActivityAt));
  return matches[0]?.sessionId;
}

export function extractOracleContextHeader(claudeMd: string, oracle: string): string {
  const normalized = claudeMd.replace(/\r\n/g, "\n").trim();
  if (!normalized) return `You are ${oracle}-oracle. Follow this oracle's repository guidance.`;

  const lines: string[] = [];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trimEnd();
    if (lines.length > 0 && /^#{2,}\s+/.test(trimmed) && lines.length >= 12) break;
    lines.push(trimmed);
    if (lines.join("\n").length >= MAX_CONTEXT_CHARS) break;
    if (lines.length >= 48) break;
  }
  const header = lines.join("\n").trim().slice(0, MAX_CONTEXT_CHARS).trim();
  const singleLine = header.replace(/\s+/g, " ").trim();
  return singleLine || `You are ${oracle}-oracle. Follow this oracle's repository guidance.`;
}

function readContext(
  localPath: string | undefined,
  oracle: string,
  deps: Required<Pick<CliCommandDeps, "existsSync" | "readFileSync">>,
): { context: string; claudePath?: string } {
  if (localPath) {
    const claudePath = join(localPath, "CLAUDE.md");
    if (deps.existsSync(claudePath)) {
      const context = extractOracleContextHeader(deps.readFileSync(claudePath, "utf-8"), oracle);
      return { context, claudePath };
    }
  }
  return { context: `You are ${oracle}-oracle. Follow this oracle's repository guidance.` };
}

export function buildClaudeCliCommand(input: { sessionId: string; context: string; binary?: string }): string {
  const binary = input.binary || DEFAULT_CLAUDE_BINARY;
  return `${binary} --resume ${shellQuote(input.sessionId)} --append-system-prompt ${shellQuote(input.context)}`;
}

export async function resolveCliInvocation(
  target: string,
  deps: CliCommandDeps = {},
): Promise<CliInvocation> {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("usage: maw cli <oracle|session[:window]> [--json]");

  const loadManifest = deps.loadManifest ?? realLoadManifest;
  const loadConfig = deps.loadConfig ?? realLoadConfig;
  const listClaudeSessions = deps.listClaudeSessions ?? realListClaudeSessions;
  const existsSync = deps.existsSync ?? realExistsSync;
  const readFileSync = deps.readFileSync ?? realReadFileSync;
  const ghqFindSync = deps.ghqFindSync ?? defaultGhqFindSync;

  const parsed = targetCandidates(trimmed);
  const manifest = loadManifest();
  const entry = findEntry(manifest, parsed);
  const oracle = normalizeOracleName(entry?.name || parsed.names[0] || trimmed);
  const names = uniq([oracle, ...parsed.names, entry?.name].map((name) => name && normalizeOracleName(name)));
  const localPath = resolveLocalPath(entry, names, { ghqFindSync, existsSync });
  const config = loadConfig();

  let source: CliInvocation["source"] = "manifest";
  let sessionId = entry?.sessionId || configSessionId(config, names);
  if (!sessionId) {
    source = "claude-sessions";
    sessionId = await sessionFromClaudeProjects(listClaudeSessions(), localPath, entry);
  } else if (!entry?.sessionId) {
    source = "config";
  }

  if (!sessionId) {
    const hint = localPath
      ? `no Claude session id found for ${trimmed} (${localPath})`
      : `no Claude session id found for ${trimmed}`;
    throw new Error(`${hint}; add it to maw config sessions/sessionIds or run Claude once in that oracle repo`);
  }

  const { context, claudePath } = readContext(localPath, oracle, { existsSync, readFileSync });
  return {
    target: trimmed,
    oracle,
    sessionId,
    claudePath,
    context,
    source,
    command: buildClaudeCliCommand({ sessionId, context }),
  };
}

export async function cmdCli(target: string | undefined, opts: CliHelperOptions = {}, deps: CliCommandDeps = {}): Promise<CliInvocation> {
  if (!target || target === "--help" || target === "-h") {
    throw new Error("usage: maw cli <oracle|session[:window]> [--json]");
  }
  const invocation = await resolveCliInvocation(target, deps);
  if (opts.json) {
    console.log(JSON.stringify(invocation, null, 2));
  } else {
    console.log(invocation.command);
  }
  return invocation;
}
