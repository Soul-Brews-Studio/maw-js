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
 * Claude Code statusLine hook (scripts/hooks/maw-statusline.sh). Each file
 * self-describes its oracle + company, so the read side filters by file fields
 * with NO tmux/company join. KEY = pane, not cwd: crew/warroom workers share one
 * repo but each has a unique pane.
 *
 * alive filter (kobo-266): intersect the pane id with live tmux panes so a dead
 * pane's lingering file is dropped, not shown as a ghost. Fail-open — tmux
 * unavailable → keep all rows so the board never blanks.
 *
 * company filter (kobo-267): a ?company= query keeps only panes stamped with
 * that company (statusline reads MAW_ROOM_COMPANY set once at spawn). No query →
 * all alive panes (host-wide, back-compat). A pane with no company is EXCLUDED
 * from a scoped query — it gets re-stamped on its next statusline tick. NEVER
 * fall back to all rows under a ?company= query (that would break scoping).
 *
 * Single host — no federation. Read-only. Missing dir / unreadable file →
 * skipped (never an error).
 */

import { readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

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
    rows: readPresenceRows(nowMs(), { alive: getAlivePanes(), company }),
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
  opts: { alive?: Set<string> | null; company?: string | null } = {},
): PresenceRow[] {
  const { alive = null, company = null } = opts;
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
    // company scope: a scoped query keeps only matching, stamped panes (never
    // falls back to all — an unstamped pane is excluded until it re-stamps).
    if (company && p.company !== company) continue;
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
      company: typeof p.company === "string" ? p.company : null,
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
