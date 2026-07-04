/**
 * Render — the worklog as a story, not raw JSON.
 *
 *   10:05  ·  worker  git push origin feat/x
 *   10:08  💬 worker  Tony: keep the hash field
 *   10:09  ⛏  worker  claim: fix #123
 *   10:15  ✓  worker  merged #123 (by tony)
 */

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
  let text = `${hhmm(e)}  ${icon}  ${displayName(e)}  ${e.summary}`;
  if (e.kind === "pr-merged" && e.by) text += ` (by ${e.by})`;
  return text;
}

// 'idle' (CC Stop) is a per-pane state signal for the board badge, never a
// timeline/inject line — drop it from every text render (kobo-109).
function visible(entries: WorklogEntry[]): WorklogEntry[] {
  return entries.filter(e => e.kind !== "idle");
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
