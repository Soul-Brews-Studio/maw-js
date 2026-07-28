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
  let text = tag
    ? `${hhmm(e)}  ${icon}  ${tag.node}:${tag.oracle} → ${displayName(e)}  ${tag.rest}`
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
