/**
 * Auto-create a board task from a `maw hey [request:<id>]` dispatch (Track 3,
 * the keystone). The board was empty because tasks needed a manual `maw company task
 * add` — the same trap that left the claim log empty. Real dispatch already
 * happens via `maw hey [request:<id>] …`, so that IS the signal: turn it into a
 * card automatically.
 *
 * Deliberately narrow + best-effort (must never break the hey hot path):
 *   - ONLY messages matching `[request:<id>]` at the start. A `re:[request:…]`
 *     reply, a normal hey, or a broadcast create nothing.
 *   - idempotent by requestId — re-sending the same `[request:<id>]` is a no-op.
 *   - create-only — no auto-done (PR-watch / manual `maw company task done` own that).
 * The cheap regex gate runs first so non-request sends pay ~nothing.
 */

import { addTask, listTasks, type TaskRecord } from "./store";
import { companyOfOracleStrict } from "../worklog/company-scope";

// `[request:<id>]` must lead the message (after optional whitespace). The id is
// the correlation id (e.g. eq3-company-ui-01).
const REQUEST_RE = /^\s*\[request:([A-Za-z0-9._-]+)\]\s*([\s\S]*)$/;
const MAX_TITLE = 80;

/**
 * Reduce a hey target to a bare oracle name for the card assignee / provenance
 * tag. Handles the common local + federation forms:
 *   "eq3"                  → "eq3"
 *   "m5:patchwork"         → "patchwork"   (node:oracle)
 *   "13-patchwork:0.0"     → "patchwork"   (session-prefixed + pane index)
 *   "05-eq3:eq3-oracle.0"  → "eq3"         (session + -oracle suffix + pane index)
 *   "phaith:01-hojo"       → "hojo"        (best-effort)
 * A segment is cleaned by stripping a trailing `.N` pane index, an `-oracle`
 * suffix, and a leading `NN-` session prefix. The last colon segment carries the
 * name — UNLESS it cleans to digits-only (a bare pane index like "0.0"→"0"),
 * in which case the first segment (the session token) holds the real name.
 * ponytail: best-effort for exotic 3-colon "node:session:window" forms — takes
 * the last non-numeric segment; if the addressing scheme grows, revisit here.
 */
export function targetOracle(target: string): string {
  const clean = (seg: string): string =>
    seg
      .replace(/\.\d+$/, "") // trailing pane index (.0)
      .replace(/-oracle$/i, "") // -oracle suffix
      .replace(/^\d+-/, "") // leading session prefix (13-patchwork)
      .trim();
  const segs = target.split(":").map((s) => s.trim()).filter(Boolean);
  const last = clean(segs.at(-1) ?? target);
  if (last && !/^\d+$/.test(last)) return last; // a real name
  return clean(segs[0] ?? "") || last || target; // last was a bare pane index → session token holds the name
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
  // kobo-216 — strict resolve: a sender that spans 2+ companies THROWS here (before any
  // card / idempotency-key work), rather than silently first-matching the wrong company
  // and minting a duplicate card. route-comm wraps this hook in try/catch (best-effort),
  // so the throw refuses the auto-create without breaking hey delivery.
  const resolveCompany = deps.resolveCompany ?? companyOfOracleStrict;
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
