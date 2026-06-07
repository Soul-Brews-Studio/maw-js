import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync, writeFileSync as fsWriteFileSync } from "fs";
import { basename, join } from "path";
import { getGhqRoot as defaultGetGhqRoot } from "../../config/ghq-root";
import { ghqFindSync as defaultGhqFindSync } from "../../core/ghq";
import { loadManifestCached, type OracleManifestEntry } from "../../lib/oracle-manifest";
import { resolveTargetCwd as defaultResolveTargetCwd } from "./target-cwd";

export interface ReceiverInboxConfig {
  node?: string;
  oracle?: string;
  psiPath?: string;
}

export interface ReceiverInboxInput {
  query: string;
  message: string;
  from: string;
  target?: string;
  to?: string;
  config?: ReceiverInboxConfig;
}

export type ReceiverInboxResult =
  | {
      ok: true;
      oracle: string;
      inboxDir: string;
      path: string;
      filename: string;
    }
  | {
      ok: false;
      oracle?: string;
      reason: string;
    };

export type ReceiverInboxWriter = (input: ReceiverInboxInput) => Promise<ReceiverInboxResult> | ReceiverInboxResult;

interface ReceiverInboxDeps {
  existsSync?: typeof fsExistsSync;
  mkdirSync?: typeof fsMkdirSync;
  writeFileSync?: typeof fsWriteFileSync;
  loadManifest?: () => OracleManifestEntry[];
  getGhqRoot?: typeof defaultGetGhqRoot;
  ghqFindSync?: typeof defaultGhqFindSync;
  resolveTargetCwd?: typeof defaultResolveTargetCwd;
  now?: () => Date;
}

function explicitEnabled(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/**
 * Production defaults to ON. Tests default to OFF unless they opt in, so broad
 * command test suites do not accidentally write into a developer's real oracle
 * inbox when exercising `maw hey`.
 */
export function receiverInboxAutoWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = explicitEnabled(env.MAW_HEY_INBOX_AUTOWRITE);
  if (explicit !== null) return explicit;
  return env.MAW_TEST_MODE !== "1";
}

export function defaultReceiverInboxWriter(): ReceiverInboxWriter | null {
  return receiverInboxAutoWriteEnabled() ? persistReceiverInbox : null;
}

function stripPaneSuffix(target: string): string {
  return target.replace(/\.[0-9]+$/, "");
}

function normalizeOracleName(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  // node:agent or node:session:window → prefer the agent/window component.
  if (value.includes(":")) {
    const parts = value.split(":").filter(Boolean);
    value = parts.length >= 3 ? parts[2]! : parts[1] ?? parts[0]!;
  }

  value = stripPaneSuffix(value);
  value = basename(value);
  value = value.replace(/^\d+-/, "");
  value = value.replace(/-oracle$/, "");
  return value || null;
}

export function resolveReceiverOracle(input: ReceiverInboxInput): string | null {
  return normalizeOracleName(input.to)
    ?? normalizeOracleName(input.target)
    ?? normalizeOracleName(input.query);
}

function repoPathCandidates(
  oracle: string,
  input: ReceiverInboxInput,
  deps: Required<Pick<ReceiverInboxDeps, "existsSync" | "loadManifest" | "getGhqRoot" | "ghqFindSync" | "resolveTargetCwd">>,
): string[] {
  const candidates: string[] = [];

  if (input.config?.psiPath && input.config.oracle && normalizeOracleName(input.config.oracle) === oracle) {
    candidates.push(input.config.psiPath.replace(/\/+$/, "").replace(/\/ψ$/, "").replace(/\/psi$/, ""));
  }

  if (input.target) {
    try {
      const cwd = deps.resolveTargetCwd(stripPaneSuffix(input.target));
      if (cwd) candidates.push(cwd);
    } catch {
      // Best effort: inbox persistence must never break message delivery.
    }
  }

  let manifest: OracleManifestEntry[] = [];
  try {
    manifest = deps.loadManifest();
  } catch {
    manifest = [];
  }
  const entry = manifest.find((e) => normalizeOracleName(e.name) === oracle || normalizeOracleName(e.window) === oracle);
  if (entry?.localPath) candidates.push(entry.localPath);
  if (entry?.repo) {
    candidates.push(join(deps.getGhqRoot(), "github.com", entry.repo));
    // Legacy callers/tests sometimes configure ghqRoot as github.com-rooted.
    candidates.push(join(deps.getGhqRoot(), entry.repo));
  }

  try {
    const ghqPath = deps.ghqFindSync(`/${oracle}-oracle$`);
    if (ghqPath) candidates.push(ghqPath);
  } catch {
    // Best effort.
  }

  return [...new Set(candidates)].filter((candidate) => {
    try {
      return deps.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function safeSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "unknown";
}

function slugifyBody(body: string): string {
  return safeSegment(body.split(/\s+/).slice(0, 6).join("-").toLowerCase()).slice(0, 48);
}

function buildInboxBody(from: string, to: string, timestamp: string, message: string): string {
  return [
    "---",
    `from: ${from}`,
    `to: ${to}`,
    `timestamp: ${timestamp}`,
    "read: false",
    "---",
    "",
    message,
    "",
  ].join("\n");
}

export function persistReceiverInbox(input: ReceiverInboxInput, deps: ReceiverInboxDeps = {}): ReceiverInboxResult {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const mkdirSync = deps.mkdirSync ?? fsMkdirSync;
  const writeFileSync = deps.writeFileSync ?? fsWriteFileSync;
  const resolvedDeps = {
    existsSync,
    loadManifest: deps.loadManifest ?? loadManifestCached,
    getGhqRoot: deps.getGhqRoot ?? defaultGetGhqRoot,
    ghqFindSync: deps.ghqFindSync ?? defaultGhqFindSync,
    resolveTargetCwd: deps.resolveTargetCwd ?? defaultResolveTargetCwd,
  };

  const oracle = resolveReceiverOracle(input);
  if (!oracle) return { ok: false, reason: "receiver oracle could not be inferred" };

  const repoPath = repoPathCandidates(oracle, input, resolvedDeps)[0];
  if (!repoPath) return { ok: false, oracle, reason: `receiver repo not found for ${oracle}` };

  const now = deps.now?.() ?? new Date();
  const timestamp = now.toISOString();
  const datePart = timestamp.slice(0, 10);
  const timePart = timestamp.slice(11, 16).replace(":", "-");
  const filename = `${datePart}_${timePart}_${safeSegment(input.from)}_${slugifyBody(input.message)}.md`;
  const inboxDir = join(repoPath, "ψ", "inbox");
  const path = join(inboxDir, filename);

  try {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(path, buildInboxBody(input.from, oracle, timestamp, input.message));
    return { ok: true, oracle, inboxDir, path, filename };
  } catch (error) {
    return {
      ok: false,
      oracle,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
