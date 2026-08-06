/**
 * maw-bg subcommand implementations.
 *
 * Wire contract per RFC#1 (Soul-Brews-Studio/maw-bg#1, all decisions locked).
 *
 * Six exported handlers map 1:1 to subcommands:
 *   bgSpawn  — `maw bg "<cmd>" [--name X]`
 *   bgList   — `maw bg ls [--json]`
 *   bgTail   — `maw bg tail <slug> [--lines N] [--follow]`
 *   bgAttach — `maw bg attach <slug>`
 *   bgKill   — `maw bg kill <slug> [--all]`
 *   bgGc     — `maw bg gc [--dry-run] [--older-than DUR]`
 *
 * Tmux is invoked via `node:child_process` (NOT Bun.spawn) for portability —
 * this plugin must run inside any maw-js host, not just bun-native ones.
 * All argv arrays are passed unspread to spawnSync, so cmd/slug strings are
 * never interpolated into a shell.
 */

import { spawnSync, spawn, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";

import { UserError } from "./internal/user-error";

// ────────────────────────────────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  /** Override the auto-derived slug. Validated against NAME_RE. */
  name?: string;
}

export interface SpawnResult {
  slug: string;
  session: string;
  cmd: string;
}

export interface BgSession {
  slug: string;
  session: string;
  ageSeconds: number;
  status: "running" | "done";
  lastLine: string;
}

export interface TailOptions {
  /** Number of lines to capture. Default 200. */
  lines?: number;
  /** Re-poll once per second until the session goes away. */
  follow?: boolean;
  /** Output sink for `--follow` mode. Defaults to process.stdout.write. */
  writer?: (chunk: string) => void;
  /** AbortSignal for the follow loop (tests use this). */
  signal?: AbortSignal;
}

export interface KillOptions {
  /** Reap every `maw-bg-*` session. */
  all?: boolean;
}

export interface GcOptions {
  /** Print the kill list, take no action. */
  dryRun?: boolean;
  /**
   * Duration string (`30s`, `5m`, `2h`, `7d`). Default 24h.
   * Sessions whose `#{session_created}` is older than now-DUR are reaped.
   */
  olderThan?: string;
}

export interface GcReport {
  reaped: string[];
  kept: string[];
  dryRun: boolean;
  thresholdSeconds: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export const SESSION_PREFIX = "maw-bg-";
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_GC_SECONDS = 24 * 60 * 60;
const FOLLOW_POLL_MS = 1000;

// ────────────────────────────────────────────────────────────────────────────
// Slug derivation (RFC#1 §"Slug naming")
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the auto-slug for a given command string.
 *
 *   sanitized-stem = first whitespace-token of cmd
 *                    → lowercased
 *                    → strip non-[a-z0-9-]
 *                    → collapse repeated `-`
 *                    → trim leading/trailing `-`
 *                    → truncate to 16 chars
 *                    → fallback "cmd" if empty
 *   hash4          = first 4 hex chars of sha256(full-cmd-string)
 */
export function deriveSlug(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) {
    throw new UserError("bg: command cannot be empty");
  }
  const firstTok = trimmed.split(/\s+/)[0] ?? "";
  let stem = firstTok
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  if (stem.length === 0) stem = "cmd";
  const hash4 = createHash("sha256").update(cmd).digest("hex").slice(0, 4);
  return `${stem}-${hash4}`;
}

/** Throws UserError if `name` doesn't satisfy `^[a-z0-9][a-z0-9-]{0,31}$`. */
export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new UserError(
      `bg: invalid --name "${name}" (must match ${NAME_RE.source})`,
    );
  }
}

/**
 * Resolve a user-supplied slug ref against currently live sessions.
 *
 * Accepts:
 *   - the full slug (`pnpmbuild-a3f1`)
 *   - the hash suffix alone (`a3f1`, 4 hex chars)
 *   - a unique stem prefix (`pnpmbuild`)
 *
 * Returns the resolved full slug, or throws UserError on miss / ambiguity.
 */
export function resolveSlug(ref: string, liveSlugs: string[]): string {
  if (liveSlugs.includes(ref)) return ref;

  // hash-suffix lookup (4 hex chars)
  if (/^[a-f0-9]{4}$/.test(ref)) {
    const hits = liveSlugs.filter((s) => s.endsWith(`-${ref}`));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new UserError(
        `bg: hash "${ref}" matches ${hits.length} sessions: ${hits.join(", ")}`,
      );
    }
  }

  // unique-prefix lookup
  const prefixHits = liveSlugs.filter((s) => s.startsWith(ref));
  if (prefixHits.length === 1) return prefixHits[0];
  if (prefixHits.length > 1) {
    throw new UserError(
      `bg: ref "${ref}" matches ${prefixHits.length} sessions: ${prefixHits.join(", ")}`,
    );
  }

  throw new UserError(`bg: no session matching "${ref}"`);
}

// ────────────────────────────────────────────────────────────────────────────
// Tmux invocation helpers
// ────────────────────────────────────────────────────────────────────────────

interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tmux(args: string[], opts: SpawnSyncOptions = {}): TmuxResult {
  const r = spawnSync("tmux", args, { encoding: "utf8", ...opts });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new UserError("bg: tmux not found on PATH", 3);
  }
  if (r.error) throw r.error;
  return {
    status: r.status ?? -1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function sessionName(slug: string): string {
  return `${SESSION_PREFIX}${slug}`;
}

function sessionExists(slug: string): boolean {
  const r = tmux(["has-session", "-t", sessionName(slug)]);
  return r.status === 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Holds-open tail (RFC#1 §"Tmux session structure")
// ────────────────────────────────────────────────────────────────────────────

/**
 * The shell snippet wrapped around the user command so the pane survives
 * after the command exits — `bg tail` and `bg ls` keep working until an
 * explicit `bg kill` (or `bg gc`).
 */
export function holdsOpen(cmd: string): string {
  // NOTE: cmd is interpolated into a shell string, but tmux will start
  // /bin/sh -c <string>, so this IS the user's intended shell command.
  // The user is the trust boundary here — same as `sh -c "$@"`.
  return `${cmd}; rc=$?; printf '\\n[done — exit %d]\\n' "$rc"; while :; do read -r _ 2>/dev/null || sleep 3600; done`;
}

// ────────────────────────────────────────────────────────────────────────────
// bgSpawn
// ────────────────────────────────────────────────────────────────────────────

export function bgSpawn(cmd: string, opts: SpawnOptions = {}): SpawnResult {
  const trimmed = (cmd ?? "").trim();
  if (!trimmed) throw new UserError("bg: command cannot be empty");

  let slug: string;
  if (opts.name !== undefined) {
    validateName(opts.name);
    slug = opts.name;
  } else {
    slug = deriveSlug(trimmed);
  }

  if (sessionExists(slug)) {
    throw new UserError(`bg: already running: ${slug}`, 2);
  }

  const r = tmux([
    "new-session", "-d",
    "-s", sessionName(slug),
    "-n", "bg",
    "/bin/sh", "-c", holdsOpen(trimmed),
  ]);
  if (r.status !== 0) {
    throw new UserError(
      `bg: tmux new-session failed (status ${r.status}): ${r.stderr.trim() || "(no stderr)"}`,
      3,
    );
  }

  return { slug, session: sessionName(slug), cmd: trimmed };
}

// Back-compat alias matching the original stub name.
export { bgSpawn as bg };

// ────────────────────────────────────────────────────────────────────────────
// bgList
// ────────────────────────────────────────────────────────────────────────────

const LIST_FORMAT =
  "#{session_name}\t#{session_created}\t#{pane_current_command}";

/**
 * List active `maw-bg-*` sessions.
 *
 * Tmux doesn't have a built-in "give me the last buffer line" — we read it
 * via `capture-pane -p -S -1 -E -1` per session.
 */
export function bgList(): BgSession[] {
  const r = tmux(["list-sessions", "-F", LIST_FORMAT]);
  if (r.status !== 0) {
    // No sessions at all means tmux exits non-zero on macOS. Treat as empty.
    if (/no server running/i.test(r.stderr) || /no current session/i.test(r.stderr)) {
      return [];
    }
    if (r.stdout.trim() === "") return [];
  }
  const now = Math.floor(Date.now() / 1000);
  const out: BgSession[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, createdRaw, paneCmd] = line.split("\t");
    if (!name?.startsWith(SESSION_PREFIX)) continue;
    const created = Number(createdRaw);
    const slug = name.slice(SESSION_PREFIX.length);
    const status = isHoldsOpenIdle(paneCmd ?? "") ? "done" : "running";
    out.push({
      slug,
      session: name,
      ageSeconds: Number.isFinite(created) ? Math.max(0, now - created) : 0,
      status,
      lastLine: lastLineOf(slug),
    });
  }
  return out;
}

function isHoldsOpenIdle(paneCmd: string): boolean {
  // After <cmd> exits, the pane is parked in either `read` or `sleep`.
  const c = paneCmd.trim().toLowerCase();
  return c === "" || c === "read" || c === "sleep" || c === "sh";
}

function lastLineOf(slug: string): string {
  const r = tmux([
    "capture-pane", "-p", "-J",
    "-t", sessionName(slug),
    "-S", "-1", "-E", "-1",
  ]);
  if (r.status !== 0) return "";
  return r.stdout.replace(/\n+$/, "").trim();
}

/** List just the slugs of live `maw-bg-*` sessions. */
export function bgListSlugs(): string[] {
  return bgList().map((s) => s.slug);
}

// ────────────────────────────────────────────────────────────────────────────
// bgTail
// ────────────────────────────────────────────────────────────────────────────

/** One-shot snapshot. Returns the captured text (no trailing newline). */
export function bgTail(slug: string, opts: TailOptions = {}): string {
  const lines = opts.lines ?? DEFAULT_TAIL_LINES;
  const resolved = resolveSlug(slug, bgListSlugs());
  const r = tmux([
    "capture-pane", "-p", "-J",
    "-t", sessionName(resolved),
    "-S", `-${lines}`,
  ]);
  if (r.status !== 0) {
    throw new UserError(
      `bg: capture-pane failed for ${resolved}: ${r.stderr.trim() || "(no stderr)"}`,
    );
  }
  return r.stdout.replace(/\n+$/, "");
}

/**
 * Follow loop — re-captures every second and writes deltas to `writer`.
 * Returns when the session goes away or `signal` aborts.
 */
export async function bgTailFollow(slug: string, opts: TailOptions = {}): Promise<void> {
  const writer = opts.writer ?? ((c) => { process.stdout.write(c); });
  const resolved = resolveSlug(slug, bgListSlugs());
  let prev = "";
  // Print initial snapshot.
  prev = bgTail(resolved, opts);
  if (prev) writer(prev + "\n");

  while (!opts.signal?.aborted) {
    await sleep(FOLLOW_POLL_MS, opts.signal);
    if (opts.signal?.aborted) break;
    if (!sessionExists(resolved)) {
      writer(`[bg: session ${resolved} ended]\n`);
      return;
    }
    const cur = bgTail(resolved, opts);
    if (cur.length > prev.length && cur.startsWith(prev)) {
      writer(cur.slice(prev.length));
    } else if (cur !== prev) {
      // Buffer rolled or content changed — reprint the tail block.
      writer(cur + "\n");
    }
    prev = cur;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// bgAttach
// ────────────────────────────────────────────────────────────────────────────

/**
 * Attach to a session. Inside an existing tmux client this becomes
 * `tmux switch-client -t <session>` so we don't nest.
 *
 * NOTE: this returns a child-process `Promise<number>` rather than a sync
 * status because attach takes over the TTY — callers should await it.
 */
export function bgAttach(slug: string): Promise<number> {
  const resolved = resolveSlug(slug, bgListSlugs());
  const insideTmux = !!process.env.TMUX;
  const args = insideTmux
    ? ["switch-client", "-t", sessionName(resolved)]
    : ["attach-session", "-t", sessionName(resolved)];
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio: "inherit" });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new UserError("bg: tmux not found on PATH", 3));
      } else {
        reject(err);
      }
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

// ────────────────────────────────────────────────────────────────────────────
// bgKill
// ────────────────────────────────────────────────────────────────────────────

export function bgKill(slug: string | undefined, opts: KillOptions = {}): string[] {
  if (opts.all) {
    const slugs = bgListSlugs();
    for (const s of slugs) tmux(["kill-session", "-t", sessionName(s)]);
    return slugs;
  }
  if (!slug) throw new UserError("bg kill: missing <slug> (or --all)");
  const resolved = resolveSlug(slug, bgListSlugs());
  const r = tmux(["kill-session", "-t", sessionName(resolved)]);
  if (r.status !== 0) {
    throw new UserError(
      `bg: kill-session failed for ${resolved}: ${r.stderr.trim() || "(no stderr)"}`,
    );
  }
  return [resolved];
}

// ────────────────────────────────────────────────────────────────────────────
// bgGc
// ────────────────────────────────────────────────────────────────────────────

const DUR_RE = /^(\d+)([smhd])$/;

/**
 * Parse a duration like `30s`, `5m`, `2h`, `7d` to seconds.
 * Throws UserError on invalid input.
 */
export function parseDuration(s: string): number {
  const m = DUR_RE.exec(s.trim());
  if (!m) {
    throw new UserError(
      `bg gc: invalid --older-than "${s}" (expected NNs/NNm/NNh/NNd)`,
    );
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default: throw new UserError(`bg gc: invalid duration unit ${m[2]}`);
  }
}

export function bgGc(opts: GcOptions = {}): GcReport {
  const thresholdSeconds = opts.olderThan
    ? parseDuration(opts.olderThan)
    : DEFAULT_GC_SECONDS;
  const sessions = bgList();
  const reaped: string[] = [];
  const kept: string[] = [];
  for (const s of sessions) {
    if (s.status === "done" && s.ageSeconds >= thresholdSeconds) {
      if (!opts.dryRun) tmux(["kill-session", "-t", s.session]);
      reaped.push(s.slug);
    } else {
      kept.push(s.slug);
    }
  }
  return { reaped, kept, dryRun: !!opts.dryRun, thresholdSeconds };
}
