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

import { addTask, isTerminalState, listTasks, noteTask, readTask, type TaskRecord } from "./store";
import { companyOfOracleStrict, companyScopeViolation } from "../worklog/company-scope";

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

// A card-id reference like `kobo-165`. The whole token is the card id
// (`<company>-<n>`, the store convention — nextTaskId); the prefix (which may
// itself contain hyphens, e.g. `kob-payment-5`) IS the company. Greedy prefix so
// multi-hyphen companies resolve to the full name, not just the last segment.
const CARD_ID_RE = /\b([a-z][a-z0-9-]*)-(\d+)\b/g;
const VIA_HEY = "[via hey"; // provenance tag prefix (also the echo guard token)

export interface AutoCaptureDeps {
  /** existence check — defaults to the real store reader. */
  readCard?: (company: string, id: string) => TaskRecord | null;
  /** append a note — defaults to the real store writer. */
  note?: (company: string, id: string, by: string, text: string, opts?: { captured?: boolean }) => TaskRecord | null;
  /** kobo-424 (D) — non-null return = sender isn't a member of `company`, refuse. Defaults to the real membership check. */
  scopeViolation?: (company: string, sender: string) => string | null;
}

/**
 * Auto-capture (kobo-165): when a `maw hey` message references EXISTING card
 * id(s) like `kobo-165`, append the message to each as a NOTE — so coordination
 * said over hey (dispatch / "รอใคร" / breakdown) lands on the board as durable
 * evidence instead of living only in a hey log. A note, not a comment: a note is
 * the append-only evidence channel (Board Truth rule 10), never a thread awaiting
 * a reply, so it is the right home for an auto-captured line.
 *
 * Best-effort + narrow, mirroring autoCreateFromDispatch:
 *   - the card must ALREADY exist (readCard by <prefix=company, id>); an unknown
 *     ref is skipped silently (never conjure a card — that's autoCreateFromDispatch).
 *   - sender must resolve (the note author); unresolved → capture nothing.
 *   - each note is tagged `[via hey→<target>]` for legible provenance AND as the
 *     echo guard: a captured note can't itself re-trigger capture. The structural
 *     anti-loop guard (excluding the `task-events` channel, on which notify pings
 *     ride carrying card-ids) lives at the call site.
 * Returns the ids captured (for tests/telemetry); [] when nothing matched.
 */
export function autoCaptureCardMentions(
  message: string,
  target: string,
  resolveSender: () => string | null,
  deps: AutoCaptureDeps = {},
): string[] {
  if (message.includes(VIA_HEY)) return []; // echo guard — never re-capture a captured note
  const refs = new Map<string, string>(); // id → company (dedups repeated ids)
  for (const m of message.matchAll(CARD_ID_RE)) refs.set(m[0], m[1]);
  if (refs.size === 0) return []; // no card ref — cheapest exit, before resolving sender

  const readCard = deps.readCard ?? readTask;
  const note = deps.note ?? noteTask;
  const scopeViolation = deps.scopeViolation ?? companyScopeViolation;
  const captured: string[] = [];
  let sender: string | null | undefined; // resolve lazily + once, only if a ref actually exists
  for (const [id, company] of refs) {
    const card = readCard(company, id);
    if (!card) continue; // unknown card → skip silently
    // kobo-424 (A) — a closed card doesn't collect auto-notes; not a permanent
    // stamp, a reopened card (state flipped off-terminal) accepts notes again.
    if (isTerminalState(card.state)) continue;
    if (sender === undefined) sender = resolveSender();
    if (!sender) break; // can't attribute the note (same reason for every ref) → stop
    // kobo-424 (D) — sender must be a member of the MENTIONED card's own company,
    // not just resolve to *a* company; a bare regex match on the message text is
    // not a membership check.
    if (scopeViolation(company, sender)) continue;
    // kobo-229: tag as `captured` so noteTask stores it (audit trail) but never
    // auto-advances the card — a hey mention is chatter, not work (mention ≠ work).
    if (note(company, id, sender, `${VIA_HEY}→${targetOracle(target)}] ${message}`, { captured: true })) captured.push(id);
  }
  return captured;
}
