/**
 * Task comment notify (kobo-46) — "comment = poke แทน hey" (spec §Notify).
 *
 * When someone OTHER than the assignee adds a note to a card, the assignee gets
 * pinged so a comment doubles as a nudge. The ping goes out on the `task-events`
 * channel, so in a multi-pane warroom it lands in the target's COORDINATOR pane
 * (the oracle declared it via `maw route set task-events .N`, kobo-36) — never
 * straight into a worker pane. No mapping registered → `maw hey` keeps its
 * default-pane behavior; the routing decision is entirely the registry's, we only
 * tag the channel.
 *
 * Isolated + best-effort: we shell `maw hey` in a detached subprocess rather than
 * calling cmdSend in-process — cmdSend can `process.exit` on a delivery error,
 * which inside the maw server would take the whole server down. A spawn failure
 * is swallowed: the note is already durably stored + worklogged, delivery is a
 * nudge on top. `send` is injectable for tests (assert the argv without spawning).
 */

import { CHANNEL_TASK_EVENTS } from "../pane-routes";
import { resolveReviewer, type TaskRecord } from "./store";
import { spawnHeyProcess } from "./hey-spawn";

function spawnHey(args: string[]): void {
  if (process.env.MAW_TEST_MODE === "1") return; // don't fire real subprocesses under test
  spawnHeyProcess(args); // kobo-405: the test preload fail-closes this even when MAW_TEST_MODE isn't set
}

/**
 * Poke someone about a new comment — the assignee, or, when the card is
 * UNASSIGNED (kobo-156), the review chain (creator → reviewer → human via
 * resolveReviewer) so a comment on an ownerless card still reaches a person
 * instead of going silent. No self-poke (commenter === target is skipped). Fires
 * even when the card is done — the assignee follows the card. Returns true when a
 * ping was dispatched, false when skipped (self-comment / nobody to reach).
 */
export function notifyTaskComment(
  task: TaskRecord,
  commenter: string,
  text: string,
  kind: "note" | "comment",
  send: (args: string[]) => void = spawnHey,
): boolean {
  const target = task.assignee || resolveReviewer(task); // owner, else the review chain (unassigned fallback, kobo-156)
  if (!target || target === commenter) return false; // self-comment or nobody to reach → nothing to poke
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
  // kobo-406: the verb must match what was actually written — a note reader who's
  // told "commented on" checks `comments` (empty) and wrongly suspects a write-path
  // bug. `kind` is a required param (not inferred) so a future 3rd caller can't
  // silently default to the wrong verb.
  const verb = kind === "note" ? "added a note on" : "commented on";
  try {
    send(["--channel", CHANNEL_TASK_EVENTS, target, `[task] ${commenter} ${verb} ${task.id}: ${preview}`]);
    return true;
  } catch {
    return false; // best-effort — the write is already stored
  }
}

/**
 * Poke the AUTHOR of a parent comment when someone replies to it (kobo-156). A
 * reply threads under an existing comment (`replyTo`); the person who wrote that
 * comment is the one the answer is aimed at, so the thread should reach them —
 * not just the card's assignee (which notifyTaskComment already handles, in
 * addition to this). No self-poke (a reply to your own comment is skipped), and a
 * `replyTo` that names no comment on the card is skipped, not crashed (commentTask
 * already rejects dangling threads upstream — this is a defensive belt). Returns
 * the pinged author, or null when skipped. `send` injectable for tests.
 */
export function notifyCommentReply(
  task: TaskRecord,
  replyTo: string,
  replier: string,
  send: (args: string[]) => void = spawnHey,
): string | null {
  const parent = task.comments?.find((c) => c.id === replyTo);
  if (!parent) return null; // replyTo names no comment on this card → skip (no crash)
  const author = parent.by;
  if (!author || author === replier) return null; // self-reply → nothing to poke
  try {
    send(["--channel", CHANNEL_TASK_EVENTS, author, `[task] ${replier} replied to your comment on ${task.id}`]);
    return author;
  } catch {
    return null; // best-effort — the comment is already stored
  }
}

/**
 * Poke the resolved reviewer when a card enters the review lane (kobo-144, Board
 * Truth rule 12). The target comes from resolveReviewer (reviewer field → creator
 * → tony) so review/hold/pr/pr-watch all notify the SAME person the board shows.
 * No self-poke (the actor pulling the card in is skipped). Returns the pinged
 * reviewer, or null when skipped (resolved to the actor). `send` injectable for tests.
 */
export function notifyReviewer(
  task: TaskRecord,
  actor: string,
  send: (args: string[]) => void = spawnHey,
): string | null {
  const reviewer = resolveReviewer(task);
  if (!reviewer || reviewer === actor) return null; // resolved to the actor → nothing to poke
  const why = task.reviewReason ? ` — ${task.reviewReason}` : "";
  try {
    send(["--channel", CHANNEL_TASK_EVENTS, reviewer, `[task] review ${task.id}${task.pr ? ` (PR #${task.pr})` : ""} → รอคุณตรวจ: ${task.title}${why}`]);
    return reviewer;
  } catch {
    return null; // best-effort — the state change is already durably stored
  }
}

/**
 * Poke a parent card's owner when one of its ask-subcards finishes (kobo-135, B3).
 * askTask (kobo-126) hangs a question as a SUBCARD (epic=parent + assignee=answerer)
 * under the asking card; the asker then had to eyeball the parent-badge ("⧉ open
 * →who") to notice the answer landed. This turns that manual check into a push:
 * when the answered subcard flips done, the parent's assignee (the asker) gets one
 * task-events ping so a closed answer surfaces itself.
 *
 * Gates (no noise, no self-poke): the done card must have been ROUTED to someone
 * (`child.assignee` set — a plain unassigned +subtask isn't an ask, so it's
 * skipped); the parent must have an owner who ISN'T the one closing it (the asker
 * closing their own subcard already knows). Returns true when a ping was
 * dispatched, false when skipped. `send` is injectable so tests assert the argv
 * without spawning.
 */
export function notifyParentOfSubcardDone(
  child: TaskRecord,
  parent: TaskRecord,
  by: string,
  send: (args: string[]) => void = spawnHey,
): boolean {
  if (!child.assignee) return false; // unassigned +subtask → not an ask, don't poke
  const owner = parent.assignee;
  if (!owner || owner === by) return false; // no asker to notify, or the asker closed it themselves
  try {
    send(["--channel", CHANNEL_TASK_EVENTS, owner, `[task] subcard ${child.id} done → ${parent.id} ตอบแล้ว: ${child.title}`]);
    return true;
  } catch {
    return false; // best-effort — the state change is already durably stored
  }
}
