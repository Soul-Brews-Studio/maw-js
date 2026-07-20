/**
 * Shared crew-teardown helper (kobo-358) — narrow scope by design:
 *   (1) predicate "is this pane crew-owned + safe-to-kill?"
 *   (2) guarded kill.
 *
 * Ported from kobo-343 /teardown SAFETY INVARIANTS (that skill is prose-only —
 * no bash helper exists there, so nothing to literally import; this module
 * re-implements the same invariants for `maw company crew spawn`'s pre-spawn
 * idempotency step):
 *   - crew-tagged (conductor/worker/worker-N/reviewer @role) OR crew-workers
 *     window ONLY — nothing else is a kill candidate.
 *   - protect the invoker pane (front is NEVER crew-spawned, never killed here)
 *     and every non-crew pane (fail-closed default).
 *   - scoped to the CURRENT tmux session only (not `-a` across the whole
 *     server) — a fleet may run multiple companies' crew cells in sibling
 *     sessions; teardown must never reach into another company's live cell.
 *   - fail-CLOSED on unknown/ambiguous: `list-panes` failing → refuse, don't
 *     guess; any pane whose role/window doesn't match a known crew pattern is
 *     left alone (default-deny, not default-allow).
 *
 * do NOT rewrite /teardown to adopt this helper in kobo-358 — that's a
 * separate follow-up (eq3 scope-out ruling).
 */
import { hostExec } from "maw-js/sdk";

// worker / worker-N / conductor / reviewer role tags — NOT "🧭 coord" (front is
// the invoker, never crew-spawned, never a kill candidate).
const CREW_ROLE_PREFIXES = ["🎼", "⚒", "🔎"];
const CREW_WORKERS_WINDOW = "crew-workers";

export interface TeardownResult {
  ok: boolean;
  error?: string;
  killed: string[];
  logs: string[];
}

function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** crew-owned + safe-to-kill predicate. Fail-closed: unknown/ambiguous → false. */
export function isCrewOwnedPane(role: string, windowName: string): boolean {
  if (CREW_ROLE_PREFIXES.some((p) => role.startsWith(p))) return true;
  if (windowName === CREW_WORKERS_WINDOW) return true;
  return false;
}

/**
 * Detect + kill leftover crew panes in the CURRENT session (idempotency —
 * called before every fresh spawn). Never touches `protectPaneId` (the
 * invoker/front pane) or any pane outside the crew role-tag/window predicate.
 */
export async function teardownCrewWindows(opts: { protectPaneId: string }): Promise<TeardownResult> {
  const killed: string[] = [];
  const logs: string[] = [];

  // kobo-362 safety fix: an empty/blank protectPaneId is NOT a "no pane" signal to
  // tmux — `tmux display-message -t '' ...` silently resolves to the CALLER's own
  // CURRENT session (exit 0, not an error), which would make the resolve-then-sweep
  // below hit the WRONG session (the operator's own cell, or another company's) —
  // exactly the cross-cell-kill invariant this helper exists to prevent. Refuse
  // BEFORE any tmux call, never let an empty target imply "current session".
  if (!opts.protectPaneId?.trim()) {
    return { ok: false, error: "empty protectPaneId — fail-closed (an empty tmux target silently resolves to the CALLER's own session, not a specific pane's — refusing rather than guessing)", killed, logs };
  }

  let session: string;
  try {
    session = (await hostExec(`tmux display-message -t ${shellArg(opts.protectPaneId)} -p '#{session_name}'`)).trim();
  } catch (e: any) {
    return { ok: false, error: `can't resolve session — fail-closed (${e.message})`, killed, logs };
  }
  if (!session) return { ok: false, error: "empty session name — fail-closed", killed, logs };

  let raw: string;
  try {
    raw = await hostExec(`tmux list-panes -s -t ${shellArg(session)} -F '#{pane_id}|||#{@role}|||#{window_name}'`);
  } catch (e: any) {
    return { ok: false, error: `can't list panes — fail-closed (${e.message})`, killed, logs };
  }

  const toKill: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const [paneId = "", role = "", windowName = ""] = line.split("|||");
    if (!paneId || paneId === opts.protectPaneId) continue; // protect invoker
    if (!isCrewOwnedPane(role, windowName)) continue; // protect non-crew (fail-closed default)
    toKill.push(paneId);
  }

  if (toKill.length === 0) {
    logs.push("no leftover crew panes — clean spawn");
    return { ok: true, killed, logs };
  }

  logs.push(`teardown: ${toKill.length} leftover crew pane(s) found in session ${session} — killing before fresh spawn`);
  for (const paneId of toKill) {
    try {
      await hostExec(`tmux kill-pane -t ${shellArg(paneId)}`);
      killed.push(paneId);
    } catch {
      /* already gone — race with a manual kill is fine, not an error */
    }
  }
  logs.push(`teardown: killed ${killed.length}/${toKill.length}`);
  return { ok: true, killed, logs };
}
