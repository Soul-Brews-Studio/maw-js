/**
 * Presence read route (kobo-104) — registered by the watch plugin's serve hook.
 * Behind auth via the "/presence" entry in elysia-auth PROTECTED (loopback UI
 * bypasses; LAN must auth) — pane model/context is company-internal (Rule 6),
 * same surface as /api/roster + /api/tasks.
 *
 *   GET /api/presence[?company=X] → { rows: [ { oracle, pane, model, model_id,
 *                          remaining_percentage, used_percentage,
 *                          total_input_tokens, context_window_size, company,
 *                          ts, stale } ] }
 *
 * Source is ~/.maw/presence/<pane>.json — one file per tmux pane, written by the
 * Claude Code statusLine hook (scripts/hooks/maw-statusline.sh). KEY = pane, not
 * cwd: crew/warroom workers share one repo but each has a unique pane.
 *
 * company scope (kobo-283, fixes kobo-267 rollout gap): a ?company= query keeps a
 * pane if its ORACLE is a member of that company per the roster (companyRoster —
 * the same authoritative source /api/roster + the Presence tab use), NOT the
 * pane file's own `company` field. The statusline company-stamp never populated
 * live (0/150 files carried it), so filtering on the file field returned 0 rows
 * and the ctx% badge went blank. Roster-join needs no per-pane re-provisioning.
 *
 * alive filter (kobo-266): intersect the pane id with live tmux panes so a dead
 * pane's lingering file is dropped, not shown as a ghost. Fail-open — tmux
 * unavailable → keep all rows so the board never blanks.
 *
 * No ?company= query → all alive panes (host-wide, back-compat). Under a scoped
 * query, an oracle not in the roster is EXCLUDED — never a fallback-to-all (that
 * would break scoping).
 *
 * Single host — no federation. Read-only. Missing dir / unreadable file →
 * skipped (never an error).
 */

import { readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { companyRoster } from "../worklog/company-scope";

// kobo-283 — resolve a company's member oracles from the AUTHORITATIVE roster
// (the same source /api/roster + the Presence tab use), NOT the presence file's
// own `company` field. The statusline company-stamp (kobo-267) never populated
// live (0/150 files), so a file-field filter returned 0 rows and the ctx% badge
// went blank. Joining on roster membership makes the scope work without depending
// on every pane re-provisioning. Injectable so tests stay hermetic (no registry).
export function rosterMembers(company: string): Set<string> {
  return new Set(companyRoster(company).map((m) => m.oracle));
}

// A pane's statusLine re-renders while it is alive, refreshing ts; once the pane
// dies the file lingers with a frozen ts. Older than this → model/ctx is no
// longer trustworthy, mark stale so the UI shows "unknown" instead of a ghost.
// ponytail: 5 min is generous to avoid false-flagging an idle-but-alive pane
// (CC may not re-render the statusline while truly idle); tighten if dead panes
// need to drop off faster.
const STALE_MS = 5 * 60 * 1000;

function presenceDir(): string {
  return join(process.env.MAW_DATA_DIR || join(homedir(), ".maw"), "presence");
}

export function handlePresenceRequest(request: Request): Response {
  const company = new URL(request.url).searchParams.get("company");
  return Response.json({
    rows: readPresenceRows(nowMs(), {
      alive: getAlivePanes(),
      company,
      members: company ? rosterMembers(company) : null,
    }),
  });
}

// Live tmux pane ids (reuse of team-status.ts's alive-set shape). null = tmux
// unavailable → caller fails OPEN (skips the alive filter) rather than blanking
// the board. ponytail: execSync is fine here — `tmux list-panes` is sub-10ms and
// the presence route is low-traffic; go async only if it ever shows on a flame.
function getAlivePanes(): Set<string> | null {
  try {
    const out = execSync("tmux list-panes -a -F '#{pane_id}'", { encoding: "utf8" });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

// Split out (no Request/Response) so tests can drive a fixed clock + dir + a
// fabricated alive set. alive=null skips the alive filter (fail open); company
// null/undefined skips the company filter (host-wide, back-compat).
export function readPresenceRows(
  now: number,
  opts: { alive?: Set<string> | null; company?: string | null; members?: Set<string> | null } = {},
): PresenceRow[] {
  const { alive = null, company = null } = opts;
  // kobo-283: allowed-oracle set for a scoped query. Injected by the handler
  // (rosterMembers) so production joins on the real roster; tests pass a fake set.
  // A scoped query with no members provided falls back to computing from the roster.
  const members = company ? (opts.members ?? rosterMembers(company)) : null;
  const dir = presenceDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no presence dir yet → nobody has a statusline capturing
  }
  const rows: PresenceRow[] = [];
  for (const f of files) {
    let p: RawPresence;
    try {
      p = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // half-written / garbage file → skip, don't fail the whole read
    }
    if (!p || typeof p.pane !== "string") continue;
    // company scope (kobo-283): keep a pane if its ORACLE is a member of the
    // company per the roster — NOT the pane file's own `company` field (which
    // the statusline never populated live, kobo-267 rollout gap). An unknown /
    // unlisted oracle is excluded from a scoped query, never a fallback-to-all.
    if (members && !(typeof p.oracle === "string" && members.has(p.oracle))) continue;
    // alive filter: drop dead panes whose file still lingers (alive=null → skip).
    if (alive && !alive.has(p.pane)) continue;
    const ts = typeof p.ts === "number" ? p.ts : 0;
    rows.push({
      oracle: p.oracle ?? null,
      pane: p.pane,
      model: p.model ?? null,
      model_id: p.model_id ?? null,
      remaining_percentage: numOrNull(p.remaining_percentage),
      used_percentage: numOrNull(p.used_percentage),
      total_input_tokens: numOrNull(p.total_input_tokens),
      context_window_size: numOrNull(p.context_window_size),
      // kobo-283: under a scoped query the pane matched via roster membership, so
      // report that company even when the file field is unstamped; host-wide reads
      // keep whatever the file carries (may be null until the statusline stamps it).
      company: company ?? (typeof p.company === "string" ? p.company : null),
      ts,
      stale: ts <= 0 || now - ts > STALE_MS,
    });
  }
  return rows;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nowMs(): number {
  return Date.now();
}

interface RawPresence {
  pane?: unknown;
  oracle?: string | null;
  ts?: unknown;
  model?: string | null;
  model_id?: string | null;
  remaining_percentage?: unknown;
  used_percentage?: unknown;
  total_input_tokens?: unknown;
  context_window_size?: unknown;
  company?: string | null;
}

export interface PresenceRow {
  oracle: string | null;
  pane: string;
  model: string | null;
  model_id: string | null;
  remaining_percentage: number | null;
  used_percentage: number | null;
  total_input_tokens: number | null;
  context_window_size: number | null;
  company: string | null;
  ts: number;
  stale: boolean;
}
