import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { loadConfig } from "maw-js/config";
import { ghqFind } from "maw-js/core/ghq";
import { loadFleetEntries } from "maw-js/commands/shared/fleet-load";
import {
  deletePending,
  loadPending,
  loadPendingById,
  updatePending,
  type PendingMessage,
} from "maw-js/commands/shared/queue-store";

// Re-export queue-store helpers so callers can import from one place.
export {
  loadPending,
  loadPendingById,
  savePending,
  updatePending,
  deletePending,
  pendingDir,
  pendingPath,
  isExpired,
  TTL_MS,
} from "maw-js/commands/shared/queue-store";
export type { PendingMessage } from "maw-js/commands/shared/queue-store";

// File naming: YYYY-MM-DD_HH-MM_<from>_<slug>.md
// Frontmatter: from / to / timestamp / read

interface InboxFrontmatter {
  from: string;
  to: string;
  timestamp: string;
  read: boolean;
}

export interface InboxMessage {
  id: string;
  filename: string;
  path: string;
  frontmatter: InboxFrontmatter;
  body: string;
  timestamp: Date;
}

export interface InboxStatus {
  oracle: string;
  unread: number;
  oldest_age_seconds: number | null;
  last_archive_age_seconds: number | null;
  delta_since_last_check: number;
  level: "green" | "red";
  reasons: string[];
}

export interface InboxDrainItem {
  id: string;
  filename: string;
  reason: string;
  age_seconds: number;
  destination: string | null;
  action: "archived" | "would_archive";
}

export interface InboxDrainResult {
  oracle: string;
  scanned: number;
  matched: number;
  archived: number;
  remaining_matches: number;
  max: number;
  dry_run: boolean;
  safe: true;
  older_than_seconds: number;
  processed_dir: string;
  items: InboxDrainItem[];
}

interface InboxCursorEntry {
  unread: number;
  latestArchiveMtimeMs: number | null;
  checkedAt: string;
}

type InboxCursorStore = Record<string, InboxCursorEntry>;

interface InboxStatusTarget {
  oracle: string;
  inboxDir: string;
}

const UNREAD_RED_THRESHOLD = 50;
const OLDEST_RED_SECONDS = 4 * 60 * 60;
const ARCHIVE_RED_SECONDS = 8 * 60 * 60;
const SAFE_DRAIN_DEFAULT_MAX = 25;
const SAFE_DRAIN_DEFAULT_MIN_AGE_SECONDS = OLDEST_RED_SECONDS;

const SAFE_DRAIN_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "ci-green", pattern: /\bci green confirmed\b/i },
  { reason: "local-ship", pattern: /\blocal ship commit\b/i },
  { reason: "alpha-pushed", pattern: /\balpha (?:coverage batch )?pushed\b/i },
  { reason: "coverage-pushed", pattern: /\bcoverage batch pushed\b/i },
  { reason: "coverage-shipped", pattern: /\bcoverage batch shipped to alpha\b/i },
  { reason: "green-batch", pattern: /\bgreen batch\b/i },
  { reason: "verified", pattern: /(?:✅|🏆).{0,120}\bverified\b|\b(?:verified\s+[0-9a-f]{7,}|[0-9a-f]{7,}\s+verified)\b|\bslice\s+\d+.{0,80}\bverified\b|\b#\d+\s+verified\b|\bbatch verified\b/i },
  { reason: "next-slice-shipped", pattern: /\bshipped next slice\b/i },
  { reason: "slice-shipped", pattern: /\bshipped\b.{0,80}\bslice\b/i },
];

export function resolveInboxDir(): string {
  const config = loadConfig();
  if (config.psiPath) return join(config.psiPath, "inbox");
  const local = join(process.cwd(), "ψ", "inbox");
  if (existsSync(local)) return local;
  return join(process.cwd(), "psi", "inbox");
}

function parseFrontmatter(content: string): { frontmatter: InboxFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm: InboxFrontmatter = { from: "unknown", to: "unknown", timestamp: "", read: false };
  if (!match) return { frontmatter: fm, body: content };
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(": ");
    if (colon < 0) continue;
    const k = line.slice(0, colon);
    const v = line.slice(colon + 2).trim();
    if (k === "from") fm.from = v;
    else if (k === "to") fm.to = v;
    else if (k === "timestamp" || k === "date") fm.timestamp = v;
    else if (k === "read") fm.read = v === "true";
  }
  return { frontmatter: fm, body: match[2].trim() };
}

function buildFrontmatter(fm: InboxFrontmatter): string {
  return `---\nfrom: ${fm.from}\nto: ${fm.to}\ntimestamp: ${fm.timestamp}\nread: ${fm.read}\n---\n`;
}

function slugify(text: string): string {
  return text.trim().split(/\s+/).slice(0, 5).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}

/**
 * Format a date as human-readable relative age (or absolute date for old/invalid).
 *
 * Defensive against the epoch-zero fallback in `loadInboxMessages` (where a
 * missing/malformed `timestamp:` frontmatter coerces to `new Date(0)` and
 * produces "20578d ago" — the #1142 bug shape).
 *
 * Contract:
 *   NaN / epoch-zero / non-positive  → "—"  (unknown/missing)
 *   future-dated (clock skew)        → "future"
 *   < 1 minute                       → "just now"
 *   < 60 minutes                     → "Nm ago"
 *   < 24 hours                       → "Nh ago"
 *   < 30 days                        → "Nd ago"
 *   ≥ 30 days                        → "YYYY-MM-DD" (absolute)
 *
 * Exported for tests; the WHEN column in `cmdInboxLs` is the production caller.
 */
export function relativeTime(date: Date): string {
  const t = date.getTime();
  if (!isFinite(t) || t <= 0) return "—";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "future";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toISOString().slice(0, 10); // YYYY-MM-DD for older items
}

function cursorPath(): string {
  const stateDir = process.env.MAW_STATE_DIR || join(homedir(), ".maw", "state");
  return join(stateDir, "inbox-cursor.json");
}

function readCursorStore(): InboxCursorStore {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as InboxCursorStore;
  } catch {
    return {};
  }
}

function writeCursorStore(store: InboxCursorStore): void {
  const path = cursorPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function stripWorktreeSuffix(name: string): string {
  return name.replace(/\.wt-.+$/, "");
}

function inferOracleNameFromCwd(): string {
  const config = loadConfig();
  const cwd = process.cwd();
  const cwdName = stripWorktreeSuffix(basename(dirname(cwd)) === "agents"
    ? basename(dirname(dirname(cwd)))
    : basename(cwd));
  return cwdName || config.oracle || config.node || "local";
}

function canonicalRepoFromCwd(): string | null {
  const cwd = process.cwd();
  if (basename(dirname(cwd)) === "agents") {
    const repo = dirname(dirname(cwd));
    if (existsSync(repo)) return repo;
  }
  const cwdName = basename(cwd);
  const stripped = stripWorktreeSuffix(cwdName);
  if (stripped !== cwdName) {
    const repo = join(dirname(cwd), stripped);
    if (existsSync(repo)) return repo;
  }
  return null;
}

function inboxDirForRepo(repoPath: string): string {
  const psi = join(repoPath, "ψ", "inbox");
  if (existsSync(psi)) return psi;
  return join(repoPath, "psi", "inbox");
}

async function resolveOracleRepo(oracle: string): Promise<string | null> {
  return (await ghqFind(`/${oracle}-oracle$`)) ?? (await ghqFind(`/${oracle}$`));
}

async function resolveInboxStatusTarget(oracleArg?: string): Promise<InboxStatusTarget> {
  if (oracleArg) {
    const repoPath = await resolveOracleRepo(oracleArg);
    if (!repoPath) throw new Error(`no oracle named '${oracleArg}' — try: maw oracle ls`);
    return { oracle: oracleArg, inboxDir: inboxDirForRepo(repoPath) };
  }

  const config = loadConfig();
  const oracle = inferOracleNameFromCwd();
  const repoPath = (await resolveOracleRepo(oracle)) ?? canonicalRepoFromCwd();
  if (repoPath) return { oracle, inboxDir: inboxDirForRepo(repoPath) };
  if (config.psiPath) return { oracle: config.oracle || oracle, inboxDir: join(config.psiPath, "inbox") };
  return { oracle, inboxDir: resolveInboxDir() };
}

export function oracleNameFromFleetWindow(window: { name?: string; repo?: string }): string | null {
  const repoName = window.repo?.split("/").filter(Boolean).pop();
  if (repoName?.endsWith("-oracle")) return repoName;
  if (window.name?.endsWith("-oracle")) return window.name;
  return window.name || repoName || null;
}

async function resolveFleetWindowRepo(window: { name?: string; repo?: string }): Promise<string | null> {
  const repo = window.repo;
  const repoName = repo?.split("/").filter(Boolean).pop();
  if (repo) {
    const bySlug = await ghqFind(`/${repo}$`);
    if (bySlug) return bySlug;
  }
  if (repoName) {
    const byRepo = await ghqFind(`/${repoName}$`);
    if (byRepo) return byRepo;
  }
  const oracle = oracleNameFromFleetWindow(window);
  return oracle ? resolveOracleRepo(oracle) : null;
}

async function resolveFleetInboxStatusTargets(): Promise<InboxStatusTarget[]> {
  const targets = new Map<string, InboxStatusTarget>();
  for (const entry of loadFleetEntries()) {
    for (const window of entry.session?.windows ?? []) {
      if (!window.name?.endsWith("-oracle")) continue;
      const oracle = oracleNameFromFleetWindow(window);
      if (!oracle || targets.has(oracle)) continue;
      const repoPath = await resolveFleetWindowRepo(window);
      if (!repoPath) continue;
      targets.set(oracle, { oracle, inboxDir: inboxDirForRepo(repoPath) });
    }
  }
  return [...targets.values()].sort((a, b) => a.oracle.localeCompare(b.oracle));
}

function topLevelInboxFiles(inboxDir: string): string[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => join(inboxDir, entry.name));
}

export function parseInboxFilenameTimestamp(filename: string): Date | null {
  const m = basename(filename).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})_/);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`);
  return isNaN(date.getTime()) ? null : date;
}

function latestArchiveMtimeMs(inboxDir: string): number | null {
  const processedDir = join(inboxDir, "processed");
  if (!existsSync(processedDir)) return null;

  let latest: number | null = null;
  for (const day of readdirSync(processedDir, { withFileTypes: true })) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    const dayDir = join(processedDir, day.name);
    for (const file of readdirSync(dayDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const mtimeMs = statSync(join(dayDir, file.name)).mtimeMs;
      latest = latest === null ? mtimeMs : Math.max(latest, mtimeMs);
    }
  }
  return latest;
}

function ageSeconds(timestampMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
}

function buildInboxStatus(
  { oracle, inboxDir }: InboxStatusTarget,
  nowMs: number,
  cursor: InboxCursorStore,
): InboxStatus {
  const files = topLevelInboxFiles(inboxDir);
  const unread = files.length;

  const oldestTimestampMs = files
    .map(file => parseInboxFilenameTimestamp(file)?.getTime() ?? null)
    .filter((time): time is number => time !== null && isFinite(time))
    .sort((a, b) => a - b)[0] ?? null;
  const oldestAgeSeconds = oldestTimestampMs === null ? null : ageSeconds(oldestTimestampMs, nowMs);

  const archiveMtimeMs = latestArchiveMtimeMs(inboxDir);
  const lastArchiveAgeSeconds = archiveMtimeMs === null ? null : ageSeconds(archiveMtimeMs, nowMs);

  const previous = cursor[oracle];
  const delta = previous ? unread - previous.unread : 0;
  const archiveAdvanced = previous
    ? archiveMtimeMs !== null &&
      (previous.latestArchiveMtimeMs === null || archiveMtimeMs > previous.latestArchiveMtimeMs)
    : false;

  const reasons: string[] = [];
  if (unread > UNREAD_RED_THRESHOLD) reasons.push("unread>50");
  if (oldestAgeSeconds !== null && oldestAgeSeconds > OLDEST_RED_SECONDS) reasons.push("oldest>4h");
  if (lastArchiveAgeSeconds !== null && lastArchiveAgeSeconds > ARCHIVE_RED_SECONDS) {
    reasons.push("since_archive>8h");
  } else if (lastArchiveAgeSeconds === null && unread > 0) {
    reasons.push("no_archive");
  }
  if (delta > 0 && !archiveAdvanced) reasons.push("delta>0_no_archive_activity");

  const status: InboxStatus = {
    oracle,
    unread,
    oldest_age_seconds: oldestAgeSeconds,
    last_archive_age_seconds: lastArchiveAgeSeconds,
    delta_since_last_check: delta,
    level: reasons.length ? "red" : "green",
    reasons,
  };

  cursor[oracle] = {
    unread,
    latestArchiveMtimeMs: archiveMtimeMs,
    checkedAt: new Date(nowMs).toISOString(),
  };

  return status;
}

export async function getInboxStatus(oracleArg?: string, nowMs = Date.now()): Promise<InboxStatus> {
  const target = await resolveInboxStatusTarget(oracleArg);
  const cursor = readCursorStore();
  const status = buildInboxStatus(target, nowMs, cursor);
  writeCursorStore(cursor);
  return status;
}

export async function getAllInboxStatuses(nowMs = Date.now()): Promise<InboxStatus[]> {
  const targets = await resolveFleetInboxStatusTargets();
  const cursor = readCursorStore();
  const statuses = targets.map(target => buildInboxStatus(target, nowMs, cursor));
  writeCursorStore(cursor);
  return statuses.sort((a, b) => {
    if (a.level !== b.level) return a.level === "red" ? -1 : 1;
    return a.oracle.localeCompare(b.oracle);
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function formatInboxStatus(status: InboxStatus): string {
  const symbol = status.level === "red" ? "🔴" : "🟢";
  const oldest = status.oldest_age_seconds === null ? "none" : formatDuration(status.oldest_age_seconds);
  const archive = status.last_archive_age_seconds === null
    ? "never"
    : `${formatDuration(status.last_archive_age_seconds)} ago`;
  const line = `${symbol} UNREAD ${status.unread} (oldest ${oldest}, last archive ${archive}, Δ ${formatDelta(status.delta_since_last_check)} last cycle)`;
  if (status.level === "green") return line;
  return `${line}\n   → not draining — consider escalation`;
}

export function formatInboxStatusList(statuses: InboxStatus[]): string {
  if (!statuses.length) return "no local fleet inboxes found";
  return statuses.map((status) => {
    const symbol = status.level === "red" ? "🔴" : "🟢";
    const oldest = status.oldest_age_seconds === null ? "none" : formatDuration(status.oldest_age_seconds);
    const archive = status.last_archive_age_seconds === null ? "never" : `${formatDuration(status.last_archive_age_seconds)} ago`;
    const reasons = status.reasons.length ? ` [${status.reasons.join(",")}]` : "";
    return `${symbol} ${status.oracle}: unread ${status.unread} (oldest ${oldest}, last archive ${archive}, Δ ${formatDelta(status.delta_since_last_check)})${reasons}`;
  }).join("\n");
}

export async function cmdInboxStatus(
  oracle?: string,
  opts: { json?: boolean; all?: boolean } = {},
): Promise<InboxStatus | InboxStatus[]> {
  if (opts.all) {
    const statuses = await getAllInboxStatuses();
    console.log(opts.json ? JSON.stringify(statuses, null, 2) : formatInboxStatusList(statuses));
    return statuses;
  }

  const status = await getInboxStatus(oracle);
  console.log(opts.json ? JSON.stringify(status, null, 2) : formatInboxStatus(status));
  return status;
}

function firstContentLine(body: string): string {
  return body.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
}

function safeDrainReason(msg: InboxMessage): string | null {
  const line = firstContentLine(msg.body);
  if (!/^\[[^\]]+\]/.test(line)) return null;
  if (/\?/.test(line)) return null;
  if (/\b(nat asked|please advise|questions?:|which issue|want your read|directive|nat says|stop checking|do not|only task)\b/i.test(line)) {
    return null;
  }

  const haystack = `${msg.filename}\n${line}`;
  for (const { reason, pattern } of SAFE_DRAIN_PATTERNS) {
    if (pattern.test(haystack)) return reason;
  }
  return null;
}

function drainTimestampMs(msg: InboxMessage): number | null {
  const fromFilename = parseInboxFilenameTimestamp(msg.filename);
  if (fromFilename) return fromFilename.getTime();
  const fromFrontmatter = msg.frontmatter.timestamp ? new Date(msg.frontmatter.timestamp) : null;
  if (fromFrontmatter && !isNaN(fromFrontmatter.getTime())) return fromFrontmatter.getTime();
  return null;
}

function archiveDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function uniqueArchivePath(processedDir: string, filename: string): string {
  const stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
  const ext = filename.endsWith(".md") ? ".md" : "";
  let candidate = join(processedDir, filename);
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = join(processedDir, `${stem}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

export async function cmdInboxDrain(
  oracle?: string,
  opts: { safe?: boolean; max?: number; dryRun?: boolean; json?: boolean; olderThanSeconds?: number } = {},
  nowMs = Date.now(),
): Promise<InboxDrainResult> {
  if (!opts.safe) throw new Error("usage: maw inbox drain [oracle-name] --safe [--max N] [--older-than-hours H] [--json] [--dry-run]");

  const target = await resolveInboxStatusTarget(oracle);
  const max = parsePositiveInt(opts.max, SAFE_DRAIN_DEFAULT_MAX);
  const olderThanSeconds = parsePositiveInt(opts.olderThanSeconds, SAFE_DRAIN_DEFAULT_MIN_AGE_SECONDS);
  const processedDir = join(target.inboxDir, "processed", archiveDay(nowMs));
  const messages = loadInboxMessages(target.inboxDir);
  const candidates = messages
    .map((msg) => {
      const reason = safeDrainReason(msg);
      const timestampMs = drainTimestampMs(msg);
      const ageSecondsValue = timestampMs === null ? null : ageSeconds(timestampMs, nowMs);
      return { msg, reason, timestampMs, ageSecondsValue };
    })
    .filter((candidate): candidate is {
      msg: InboxMessage;
      reason: string;
      timestampMs: number;
      ageSecondsValue: number;
    } => (
      candidate.reason !== null &&
      candidate.timestampMs !== null &&
      candidate.ageSecondsValue !== null &&
      candidate.ageSecondsValue >= olderThanSeconds
    ))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const selected = candidates.slice(0, max);
  if (selected.length && !opts.dryRun) mkdirSync(processedDir, { recursive: true });

  const items: InboxDrainItem[] = [];
  for (const candidate of selected) {
    const destination = uniqueArchivePath(processedDir, candidate.msg.filename);
    if (!opts.dryRun) {
      renameSync(candidate.msg.path, destination);
      const archiveTime = new Date(nowMs);
      utimesSync(destination, archiveTime, archiveTime);
    }
    items.push({
      id: candidate.msg.id,
      filename: candidate.msg.filename,
      reason: candidate.reason,
      age_seconds: candidate.ageSecondsValue,
      destination,
      action: opts.dryRun ? "would_archive" : "archived",
    });
  }

  const result: InboxDrainResult = {
    oracle: target.oracle,
    scanned: messages.length,
    matched: candidates.length,
    archived: items.length,
    remaining_matches: Math.max(0, candidates.length - items.length),
    max,
    dry_run: Boolean(opts.dryRun),
    safe: true,
    older_than_seconds: olderThanSeconds,
    processed_dir: processedDir,
    items,
  };

  console.log(opts.json ? JSON.stringify(result, null, 2) : formatInboxDrainResult(result));
  return result;
}

export function formatInboxDrainResult(result: InboxDrainResult): string {
  const verb = result.dry_run ? "would archive" : "archived";
  const lines = [
    `${result.oracle}: ${verb} ${result.archived}/${result.matched} safe stale inbox message(s) (scanned ${result.scanned}, max ${result.max})`,
  ];
  if (result.remaining_matches > 0) lines.push(`   → ${result.remaining_matches} safe match(es) remain after max cap`);
  if (!result.items.length) {
    lines.push(`   → no messages matched the safe stale-ack filter`);
    return lines.join("\n");
  }
  for (const item of result.items.slice(0, 10)) {
    lines.push(`   - ${item.filename} [${item.reason}, ${formatDuration(item.age_seconds)}]`);
  }
  if (result.items.length > 10) lines.push(`   - … ${result.items.length - 10} more`);
  lines.push(`   → ${result.dry_run ? "preview" : "processed"}: ${result.processed_dir}`);
  return lines.join("\n");
}

export function writeInboxFile(inboxDir: string, from: string, to: string, body: string): string {
  if (!existsSync(inboxDir)) mkdirSync(inboxDir, { recursive: true });
  const now = new Date();
  const ts = now.toISOString().slice(0, 10) + "_" + now.toTimeString().slice(0, 5).replace(":", "-");
  const filename = `${ts}_${from}_${slugify(body)}.md`;
  const fm: InboxFrontmatter = { from, to, timestamp: now.toISOString(), read: false };
  writeFileSync(join(inboxDir, filename), buildFrontmatter(fm) + "\n" + body + "\n");
  return filename;
}

export function loadInboxMessages(inboxDir: string): InboxMessage[] {
  if (!existsSync(inboxDir)) return [];
  const messages: InboxMessage[] = [];
  for (const f of readdirSync(inboxDir)) {
    if (!f.endsWith(".md")) continue;
    const path = join(inboxDir, f);
    try {
      const content = readFileSync(path, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);
      // #1142 — resolve timestamp: try frontmatter first, then filename pattern,
      // then file mtime. Avoids epoch-0 fallback that produces "20578d ago".
      let ts = frontmatter.timestamp ? new Date(frontmatter.timestamp) : null;
      if (!ts || isNaN(ts.getTime())) {
        const m = f.match(/^(\d{4})-?(\d{2})-?(\d{2})[_T](\d{2})-?(\d{2})/);
        ts = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`) : null;
      }
      if (!ts || isNaN(ts.getTime())) {
        const { statSync } = require("fs");
        ts = new Date(statSync(path).mtimeMs);
      }
      messages.push({
        id: f.replace(/\.md$/, ""),
        filename: f,
        path,
        frontmatter,
        body,
        timestamp: ts,
      });
    } catch { /* skip unreadable files */ }
  }
  return messages.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

export async function cmdInboxLs(opts: { unread?: boolean; from?: string; last?: number } = {}) {
  let msgs = loadInboxMessages(resolveInboxDir());
  if (opts.unread) msgs = msgs.filter(m => !m.frontmatter.read);
  if (opts.from) msgs = msgs.filter(m => m.frontmatter.from === opts.from);
  if (!msgs.length) { console.log("\x1b[90mno inbox messages\x1b[0m"); return; }
  const shown = msgs.slice(0, opts.last ?? 20);

  const FROM_W = 14;
  const WHEN_W = 10;
  console.log(`\n\x1b[36mINBOX\x1b[0m (${msgs.length} total)\n`);
  console.log(`  ${"R"} ${"FROM".padEnd(FROM_W)} ${"WHEN".padEnd(WHEN_W)} SUBJECT`);
  console.log(`  ${"-"} ${"-".repeat(FROM_W)} ${"-".repeat(WHEN_W)} ${"-".repeat(44)}`);
  for (const msg of shown) {
    const dot = msg.frontmatter.read ? "\x1b[90m○\x1b[0m" : "\x1b[32m●\x1b[0m";
    const from = msg.frontmatter.from.slice(0, FROM_W).padEnd(FROM_W);
    const when = relativeTime(msg.timestamp).padEnd(WHEN_W);
    const subject = msg.body.replace(/\n/g, " ").slice(0, 50);
    console.log(`  ${dot} ${from} ${when} ${subject}`);
  }
  console.log();
}

export async function cmdInboxMarkRead(id: string) {
  if (!id) { console.error("usage: maw inbox read <id>"); return; }
  const msgs = loadInboxMessages(resolveInboxDir());
  const msg = msgs.find(m => m.id === id || m.filename.includes(id));
  if (!msg) { console.error(`\x1b[31merror\x1b[0m: message not found: ${id}`); return; }
  if (msg.frontmatter.read) { console.log(`\x1b[90malready read:\x1b[0m ${msg.filename}`); return; }
  const content = readFileSync(msg.path, "utf-8");
  writeFileSync(msg.path, content.replace(/^read: false$/m, "read: true"));
  console.log(`\x1b[32m✓\x1b[0m marked read: ${msg.filename}`);
}

// Legacy write shim — used by the oracle inbox skill
export async function cmdInboxRead(target?: string) {
  const msgs = loadInboxMessages(resolveInboxDir());
  if (!msgs.length) { console.log("\x1b[90mno inbox messages\x1b[0m"); return; }
  const n = target ? parseInt(target) : NaN;
  const msg = !target ? msgs[0]
    : !isNaN(n) ? msgs[n - 1]
    : msgs.find(m => m.id.toLowerCase().includes(target.toLowerCase()));
  if (!msg) { console.error(`\x1b[31merror\x1b[0m: not found: ${target}`); return; }
  console.log(`\n\x1b[36m${msg.filename}\x1b[0m\n\x1b[90mfrom: ${msg.frontmatter.from}  ${msg.timestamp.toISOString()}\x1b[0m\n`);
  console.log(msg.body);
}

// Legacy write shim
export async function cmdInboxWrite(note: string) {
  const inboxDir = resolveInboxDir();
  if (!existsSync(inboxDir)) { console.error(`\x1b[31merror\x1b[0m: inbox not found: ${inboxDir}`); return; }
  const config = loadConfig();
  const filename = writeInboxFile(inboxDir, config.node ?? "cli", config.node ?? "local", note);
  console.log(`\x1b[32m✓\x1b[0m wrote \x1b[33m${filename}\x1b[0m`);
}

// ─── Approval queue (#842 Sub-C) ────────────────────────────────────────────
//
// `cmdList` / `cmdApprove` / `cmdReject` / `cmdShow` operate on the
// per-message JSON files under `<CONFIG_DIR>/pending/` written by
// `comm-send.ts` when `evaluateAclFromDisk(...) === "queue"`. The plugin
// dispatcher in `index.ts` peels the verb off and routes here.
//
// Approve flow: flip status → re-issue the send via `cmdSend(query, message)`
// (the same code path operators take with `maw hey`). On a successful send
// we delete the file (the approval was the gate; the file no longer needs
// to exist). Reject flow: flip status briefly so observers can see the
// terminal state, then delete the file unconditionally.

/**
 * Resolve a partial id (e.g. user types the timestamp prefix) to a full
 * pending file. Returns the loaded {@link PendingMessage} or `null`. If
 * multiple pending files match the prefix, the oldest is returned —
 * mirrors the "oldest first" semantics of `cmdQueueList()`.
 */
export function resolvePendingId(idOrPrefix: string): PendingMessage | null {
  if (!idOrPrefix) return null;
  // Exact match first — common case after `maw inbox pending` prints the id.
  const exact = loadPendingById(idOrPrefix);
  if (exact) return exact;
  // Fallback: prefix match. List loads + reaps in one pass; the user is
  // never given a stale id by the list output, so prefix is safe.
  const list = loadPending();
  const matches = list.filter(m => m.id.startsWith(idOrPrefix));
  if (matches.length === 0) return null;
  return matches[0]; // oldest first
}

/** List pending messages, oldest first. Pure read — no mutation. */
export function cmdQueueList(): PendingMessage[] {
  return loadPending().filter(m => m.status === "pending");
}

/**
 * Format the pending list for human consumption. Mirrors `formatList` in
 * `scope/impl.ts` and `trust/impl.ts` — padded columns, header + divider.
 */
export function formatQueueList(rows: PendingMessage[]): string {
  if (!rows.length) return "no pending messages";
  const header = ["id", "sender", "target", "sentAt", "preview"];
  const lines = rows.map(r => [
    r.id,
    r.sender,
    r.target,
    r.sentAt,
    r.message.replace(/\s+/g, " ").slice(0, 50),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    fmt(header),
    fmt(widths.map(w => "-".repeat(w))),
    ...lines.map(fmt),
  ].join("\n");
}

/** Show a single pending message in human-readable detail. */
export function formatQueueDetail(msg: PendingMessage): string {
  return [
    `id:      ${msg.id}`,
    `sender:  ${msg.sender}`,
    `target:  ${msg.target}`,
    `query:   ${msg.query ?? "-"}`,
    `sentAt:  ${msg.sentAt}`,
    `status:  ${msg.status}`,
    `message:`,
    msg.message,
  ].join("\n");
}

/**
 * Approve a queued message → mark status "approved" + execute the send via
 * `cmdSend(query, message)` (lazy import to avoid a circular module load:
 * comm-send imports this plugin's loader chain). On successful send we
 * delete the file. Returns the record that was just approved (status
 * pre-delete) for caller logging.
 *
 * Throws if the id is unknown or the underlying send rejects (the file is
 * left intact in that case so the operator can retry).
 */
export async function cmdApprove(idOrPrefix: string): Promise<PendingMessage> {
  const found = resolvePendingId(idOrPrefix);
  if (!found) throw new Error(`pending message not found: ${idOrPrefix}`);
  if (found.status !== "pending") {
    throw new Error(`message ${found.id} is already ${found.status}`);
  }
  const updated = updatePending(found.id, { status: "approved" });
  // Re-issue the send. Use the original query string when present (preserves
  // node prefix routing); fall back to target name otherwise.
  const query = updated.query ?? updated.target;
  const { cmdSend } = await import("maw-js/commands/shared/comm-send");
  // Pass `force=true` plus a sentinel to bypass ACL on the second pass:
  // the human approval IS the gate — re-checking here would loop forever.
  process.env.MAW_ACL_BYPASS = "1";
  try {
    await cmdSend(query, updated.message);
  } finally {
    delete process.env.MAW_ACL_BYPASS;
  }
  // Successful send → file's job is done. Delete it.
  deletePending(updated.id);
  return updated;
}

/**
 * Reject a queued message → mark status "rejected" + delete the file.
 * Returns the record (with status flipped) so the caller can log the
 * rejection. Throws on unknown id.
 */
export function cmdReject(idOrPrefix: string): PendingMessage {
  const found = resolvePendingId(idOrPrefix);
  if (!found) throw new Error(`pending message not found: ${idOrPrefix}`);
  if (found.status === "rejected") {
    // Idempotent — already rejected. Still delete in case the file was left
    // behind by a partial earlier reject.
    deletePending(found.id);
    return found;
  }
  const updated = updatePending(found.id, { status: "rejected" });
  deletePending(updated.id);
  return updated;
}

/**
 * Show a single pending message by id. Returns `null` if not found —
 * the dispatcher converts that to a CLI error. Pure read.
 */
export function cmdShow(idOrPrefix: string): PendingMessage | null {
  return resolvePendingId(idOrPrefix);
}
