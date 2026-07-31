import type { TaskRecord, TaskState } from "./store";

export type HeldRole = "worker" | "reviewer" | "main/decision" | "external-wait";

export interface StuckCard {
  id: string;
  role: HeldRole;
  holder: string | null;
  ageMs: number;
}

/** Pure pull probe: updatedTs is the durable lower-bound for the current hold. */
export function stuckCards(tasks: TaskRecord[], now = Date.now(), thresholdMs = 30 * 60_000): StuckCard[] {
  return tasks.flatMap((task) => {
    const role: HeldRole | null = task.state === "in-progress" ? "worker"
      : task.state === "review" ? "reviewer"
      : task.state === "external-wait" ? "external-wait"
      : task.state === "approve" || task.state === "need-answer" ? "main/decision" : null;
    if (!role) return [];
    const ageMs = Math.max(0, now - (task.updatedTs ?? task.ts));
    return ageMs >= thresholdMs ? [{ id: task.id, role, holder: role === "worker" ? task.assignee : role === "reviewer" ? (task.reviewer ?? null) : null, ageMs }] : [];
  });
}

export interface ParkedCardRate { parked: number; total: number; rate: number; states: TaskState[]; }
export function parkedCardRate(tasks: TaskRecord[], sinceMs: number, now = Date.now()): ParkedCardRate {
  const parkedStates: TaskState[] = ["blocked", "need-answer", "approve", "external-wait"];
  const recent = tasks.filter((t) => (t.updatedTs ?? t.ts) >= sinceMs && (t.updatedTs ?? t.ts) <= now);
  const parked = recent.filter((t) => parkedStates.includes(t.state)).length;
  return { parked, total: recent.length, rate: recent.length ? parked / recent.length : 0, states: parkedStates };
}

export interface PrCardMismatch {
  cardState: TaskState;
  prState?: string;
  mismatch: boolean;
  reason: string;
}
export function prCardMismatch(task: TaskRecord, pr: { state?: string; merged?: boolean; closed?: boolean } | null): PrCardMismatch {
  if (!task.pr) return { cardState: task.state, mismatch: false, reason: "no PR linked" };
  if (!pr) return { cardState: task.state, mismatch: true, reason: "PR state unavailable; lane is unverified" };
  const merged = pr.merged === true || pr.state === "MERGED";
  const closed = pr.closed === true || pr.state === "CLOSED";
  const mismatch = (merged && task.state !== "done" && task.state !== "wait-for-deploy") || (closed && !merged && task.state === "review");
  return { cardState: task.state, prState: pr.state, mismatch, reason: mismatch ? "PR and card lane disagree" : "card and PR shape agree" };
}

export function evidenceScopeLocusConflict(task: TaskRecord): boolean {
  const loci = (task.evidence ?? []).map((e) => e.locus).filter(Boolean);
  if (new Set(loci).size !== loci.length) return true;
  return !!task.crewSignedEvidenceLocus && !!task.headSignedEvidenceLocus && task.crewSignedEvidenceLocus === task.headSignedEvidenceLocus;
}

