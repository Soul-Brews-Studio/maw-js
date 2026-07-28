/**
 * Render — the worklog as a story, not raw JSON.
 *
 *   10:05  ·  worker  git push origin feat/x
 *   10:08  💬 worker  Tony: keep the hash field
 *   10:09  ⛏  worker  claim: fix #123
 *   10:15  ✓  worker  merged #123 (by tony)
 *
 * kobo-586: a `conversation` entry's own oracle/pane is who RECEIVED the
 * prompt (UserPromptSubmit fires on the receiving pane, whether a human typed
 * it there or a `maw hey` delivery landed there — significant.ts). When the
 * summary carries a `[node:oracle]` sender tag (formatSignedMessage,
 * comm-send.ts), the line below shows BOTH roles explicitly — sender → RECEIVER
 * — instead of one name that reads as "who's speaking" when it's really "who
 * received this":
 *
 *   10:08  💬  m5:stitch → eq3.0  Tony: keep the hash field
 *
 * kobo-586 review round 1: the `sender` half of that arrow is the sender AS
 * DECLARED BY THE MESSAGE, not a system-verified sender — `parseSignedPrefix`
 * only recognizes the `[node:oracle]` shape, it doesn't authenticate who
 * wrote it. `comm-send.ts`'s `formatSignedMessage` passes an already-present
 * tag through unmodified (comm-send.ts:369), so anyone who types
 * `[m5:tony] ...` into their own outgoing message gets that exact tag
 * rendered here. Do not treat this line as proof of who actually sent a
 * message (same class of gap as the forge-actor issue in kobo-335). A parse
 * succeeding is also not proof this was ever a real sender tag AT ALL — see
 * `parseSignedPrefix`'s own docstring in comm-send.ts (kobo-590's scope).
 *
 * kobo-586 round 3 — a crew cell has several panes of ONE oracle
 * (conductor/lead/reviewer/worker), distinguished by a ROLE typed after the
 * sender: `[m5:eq3 conductor]`. That role is captured separately and rendered
 * as its own badge, sender first:
 *
 *   10:08  💬  m5:eq3 (conductor) → eq3.0  Tony: keep the hash field
 */

import { parseSignedPrefix } from "../../commands/shared/comm-send";
import type { WorklogEntry } from "./types";

const ICON: Record<WorklogEntry["kind"], string> = {
  tool: "·",
  conversation: "💬",
  "pr-opened": "→",
  "pr-merged": "✓",
  "pr-closed": "✗",
  claim: "⛏",
  "claim-release": "✔",
  "task-archived": "📦",
  "task-blocked": "⚑",
  "task-unblocked": "🔓",
  "task-updated": "↳",
  interrupt: "⚠",
  idle: "·", // filtered from renders (visible()) — present for completeness
  error: "🛑", // kobo-111 — turn-ending API error; kept in the feed (rare + actionable)
  away: "○", // mawjs-3 — pane stepped away; filtered from renders like idle
};

function hhmm(e: WorklogEntry): string {
  const d = e.iso ? new Date(e.iso) : new Date(e.ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Display name — appends the `.N` pane suffix when present (back-compat: bare
 *  `oracle` for old entries / non-tmux contexts that never stamped a pane). */
function displayName(e: WorklogEntry): string {
  return e.pane ? `${e.oracle}.${e.pane}` : e.oracle;
}

function line(e: WorklogEntry): string {
  const icon = ICON[e.kind] ?? "·";
  // kobo-586: only a `conversation` entry can carry a hey-delivered sender tag
  // (it's the ONLY kind sourced from UserPromptSubmit, per significant.ts) —
  // other kinds' summaries are self-authored (tool calls, PR events, etc.),
  // never someone else's message landing in this pane.
  const tag = e.kind === "conversation" ? parseSignedPrefix(e.summary) : null;
  // kobo-586 round 3 (eq3's AC ②): a crew cell has multiple panes of ONE oracle,
  // distinguished by a ROLE typed after the sender (`[m5:eq3 conductor]`) — that
  // role is what actually tells two panes of the same oracle apart, so it must
  // render as its OWN badge next to the sender, never disappear and never get
  // concatenated into the message body (`tag.rest` stays exactly what the sender
  // typed after the closing `]`, untouched).
  const roleBadge = tag?.role ? ` (${tag.role})` : "";
  let text = tag
    ? `${hhmm(e)}  ${icon}  ${tag.node}:${tag.oracle}${roleBadge} → ${displayName(e)}  ${tag.rest}`
    : `${hhmm(e)}  ${icon}  ${displayName(e)}  ${e.summary}`;
  if (e.kind === "pr-merged" && e.by) text += ` (by ${e.by})`;
  return text;
}

// 'idle' (kobo-109) + 'away' (mawjs-3) + 'back' (kobo-120) are per-pane state signals
// for the board, never a timeline/inject line — drop them from every text render.
function visible(entries: WorklogEntry[]): WorklogEntry[] {
  return entries.filter(e => e.kind !== "idle" && e.kind !== "away" && e.kind !== "back");
}

/** Full chronological timeline. */
export function renderTimeline(entries: WorklogEntry[]): string {
  const rows = visible(entries);
  if (!rows.length) return "worklog ว่าง — ยังไม่มี activity บันทึก";
  return rows.map(line).join("\n");
}

/** Compact render used for hook injection (each line prefixed for context). */
export function renderLines(entries: WorklogEntry[]): string[] {
  return visible(entries).map(line);
}
