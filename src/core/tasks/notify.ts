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
import type { TaskRecord } from "./store";

function spawnHey(args: string[]): void {
  if (process.env.MAW_TEST_MODE === "1") return; // don't fire real subprocesses under test
  Bun.spawn(["maw", "hey", ...args], { stdout: "ignore", stderr: "ignore" });
}

/**
 * Poke the assignee about a new comment — but only when the commenter is NOT the
 * assignee (no self-poke) and the card actually has an owner. Returns true when a
 * ping was dispatched, false when skipped (self-comment / unowned).
 */
export function notifyTaskComment(
  task: TaskRecord,
  commenter: string,
  text: string,
  send: (args: string[]) => void = spawnHey,
): boolean {
  const assignee = task.assignee;
  if (!assignee || assignee === commenter) return false; // self-comment or no owner → nothing to poke
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
  try {
    send(["--channel", CHANNEL_TASK_EVENTS, assignee, `[task] ${commenter} commented on ${task.id}: ${preview}`]);
    return true;
  } catch {
    return false; // best-effort — the note is already stored
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
