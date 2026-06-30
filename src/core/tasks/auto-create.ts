/**
 * Auto-create a board task from a `maw hey [request:<id>]` dispatch (Track 3,
 * the keystone). The board was empty because tasks needed a manual `maw task
 * add` — the same trap that left the claim log empty. Real dispatch already
 * happens via `maw hey [request:<id>] …`, so that IS the signal: turn it into a
 * card automatically.
 *
 * Deliberately narrow + best-effort (must never break the hey hot path):
 *   - ONLY messages matching `[request:<id>]` at the start. A `re:[request:…]`
 *     reply, a normal hey, or a broadcast create nothing.
 *   - idempotent by requestId — re-sending the same `[request:<id>]` is a no-op.
 *   - create-only — no auto-done (PR-watch / manual `maw task done` own that).
 * The cheap regex gate runs first so non-request sends pay ~nothing.
 */

import { addTask, listTasks, type TaskRecord } from "./store";
import { companyOfOracle } from "../worklog/company-scope";

// `[request:<id>]` must lead the message (after optional whitespace). The id is
// the correlation id (e.g. eq3-company-ui-01).
const REQUEST_RE = /^\s*\[request:([A-Za-z0-9._-]+)\]\s*([\s\S]*)$/;
const MAX_TITLE = 80;

/** Strip node/session prefix + an "-oracle" suffix → bare oracle name. */
export function targetOracle(target: string): string {
  const last = target.split(":").map((s) => s.trim()).filter(Boolean).at(-1) ?? target;
  return last.replace(/-oracle$/i, "").trim() || target;
}

export interface RequestDispatch {
  requestId: string;
  title: string;
}

/**
 * Parse a request dispatch out of a hey message. Returns null when it is not a
 * `[request:<id>]` lead — including `re:` replies, which must NOT create a task.
 */
export function parseRequestDispatch(message: string): RequestDispatch | null {
  if (/^\s*re:/i.test(message)) return null; // reply, not a new request
  const m = REQUEST_RE.exec(message);
  if (!m) return null;
  const requestId = m[1];
  const body = m[2] ?? "";
  // title = first non-empty line after the tag, trimmed
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? requestId;
  return { requestId, title: firstLine.slice(0, MAX_TITLE) };
}

/** Pull an optional `target_repo: owner/name` out of the request body. */
export function parseRepo(message: string): string | undefined {
  const m = /target_repo:\s*(\S+)/i.exec(message);
  return m?.[1];
}

/** Existing card for this requestId in the company, if any (idempotency check). */
export function findByRequestId(company: string, requestId: string): TaskRecord | null {
  return listTasks(company).find((t) => t.requestId === requestId) ?? null;
}

/**
 * Turn a `maw hey [request:<id>]` dispatch into a board card. `resolveSender` is
 * a thunk so the (potentially throwing) sender resolution only runs AFTER the
 * cheap regex confirms this is a request. Returns the created task, or null when
 * nothing was created (not a request, no sender/company, or idempotent dup).
 */
export interface AutoCreateDeps {
  /** oracle → company. Defaults to the real worklog company-scope resolver. */
  resolveCompany?: (oracle: string) => string | null;
}

export function autoCreateFromDispatch(
  message: string,
  target: string,
  resolveSender: () => string | null,
  deps: AutoCreateDeps = {},
): TaskRecord | null {
  const parsed = parseRequestDispatch(message);
  if (!parsed) return null; // not a [request:] (or a re: reply) — cheapest exit

  const sender = resolveSender();
  if (!sender) return null;
  const resolveCompany = deps.resolveCompany ?? companyOfOracle;
  const company = resolveCompany(sender);
  if (!company) return null; // sender has no company → nothing to scope the card to

  if (findByRequestId(company, parsed.requestId)) return null; // idempotent — already on the board

  const repo = parseRepo(message);
  return addTask({
    company,
    title: parsed.title,
    by: sender,
    assignee: targetOracle(target), // dispatch = work already started
    state: "in-progress", // dispatch is the start signal (manual add stays todo)
    requestId: parsed.requestId,
    ...(repo ? { repo } : {}),
  });
}
