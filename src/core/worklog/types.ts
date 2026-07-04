/**
 * Worklog — the engine-first "desync-killer" activity log.
 *
 * A durable, append-only stream of *significant* activity, scoped per **company**
 * (one log per company; boundary = company members). The point is an engine that
 * runs itself: CC hooks capture activity AND inject recent state back before an
 * agent acts — so nobody has to remember to run a command, yet desync stops.
 *
 * Kinds:
 *   - tool          significant tool call (git/gh Bash, Edit/Write)
 *   - conversation  a decision/instruction (UserPromptSubmit, "Tony→oracle: X")
 *   - pr-opened/merged/closed   PR lifecycle (gh ground truth)
 *   - claim / claim-release     soft-lock announce + release (collision guard)
 *   - task-created / task-done  task lifecycle (board backbone, ADR 0001)
 *   - task-note     append-only note on a card (kobo-39 — mid-flight truth)
 *   - interrupt     reserved — no clean CC hook (deferred)
 *
 * See thread `eq3-lead-dispatch-lock`.
 */

export type WorklogKind =
  | "tool"
  | "conversation"
  | "pr-opened"
  | "pr-merged"
  | "pr-closed"
  | "claim"
  | "claim-release"
  | "task-created"
  | "task-review"
  | "task-done"
  | "task-rejected"
  | "task-archived"
  | "task-blocked"
  | "task-unblocked"
  | "task-note"
  | "task-updated"
  | "interrupt";

export interface WorklogEntry {
  ts: number; // epoch ms (sort key)
  iso: string; // ISO-8601 timestamp
  oracle: string; // who produced the event
  pane?: string; // tmux pane index (#{pane_index}) — distinguishes multiple panes
  //              of one oracle (human/coord/worker). Optional: old entries + non-tmux
  //              contexts omit it. NEVER folded into `oracle` (that string feeds
  //              company/scope lookups) — the `name.N` suffix is a DISPLAY concern.
  company?: string; // routing key — which company's log this belongs to
  kind: WorklogKind;
  summary: string; // human one-liner
  repo?: string; // org/repo (PR events)
  pr?: number; // PR number (PR events)
  by?: string; // actor for pr-merged/closed (who merged)
  task?: string; // claim subject (claim / claim-release)
}
