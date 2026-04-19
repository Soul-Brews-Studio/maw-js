/**
 * Consent request orchestration (#644 Phase 1).
 *
 * Two roles:
 *   - INITIATOR: requestConsent() — generates PIN, posts to peer, persists
 *     mirror locally, returns to caller. Caller decides whether to print
 *     the PIN to the user (yes — that's the OOB channel) and abort the
 *     pending action.
 *   - TARGET: approveConsent() — local-only call (the human at the target
 *     types the PIN they received OOB), verifies + flips status + writes
 *     trust entry.
 *
 * Phase 1 does NOT poll for status. Caller exits and user re-runs after
 * approval. Polling is Phase 2.
 *
 * Identity note: the INITIATOR's claimed `from` (their node name) is
 * unauthenticated by design. The OOB PIN channel is the authentication —
 * the human at the target reads the PIN aloud / via Signal / on screen
 * and confirms it matches what the initiator sees. If it doesn't match,
 * the request is fraudulent.
 */
import { randomBytes } from "crypto";
import { generatePin, hashPin, verifyPin } from "./pin";
import {
  type PendingRequest, type TrustEntry, type ConsentAction,
  writePending, readPending, updateStatus, recordTrust,
} from "./store";

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ConsentRequest {
  from: string;
  to: string;
  action: ConsentAction;
  summary: string;
  /** Peer federation URL (e.g. http://peer:3456). Omit for local self-test. */
  peerUrl?: string;
  /** Test injection — overrides the global fetch for unit tests. */
  fetchImpl?: typeof fetch;
}

export interface ConsentResult {
  ok: boolean;
  requestId?: string;
  /** PLAINTEXT pin — show to the user via the OOB channel (terminal). */
  pin?: string;
  expiresAt?: string;
  error?: string;
  /** True iff already trusted — caller can skip without prompting. */
  alreadyTrusted?: boolean;
}

export function newRequestId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * INITIATOR side. Generates PIN + id, posts to peer's /api/consent/request,
 * mirrors the pending entry locally so `maw consent list` on the initiator
 * shows what's outstanding.
 *
 * Returns the plaintext PIN to the caller — caller MUST surface it to the
 * human via the terminal so they can relay it OOB to the target operator.
 */
export async function requestConsent(req: ConsentRequest): Promise<ConsentResult> {
  const pin = generatePin();
  const id = newRequestId();
  const now = Date.now();
  const pending: PendingRequest = {
    id,
    from: req.from,
    to: req.to,
    action: req.action,
    summary: req.summary,
    pinHash: hashPin(pin),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    status: "pending",
  };

  // Mirror locally first — if the network call fails, the user can still
  // see "what did I try to send" via `maw consent list --mine`.
  writePending(pending);

  if (req.peerUrl) {
    const fetchFn = req.fetchImpl ?? fetch;
    try {
      const res = await fetchFn(new URL("/api/consent/request", req.peerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending),
      });
      if (!res.ok) {
        return { ok: false, requestId: id, error: `peer rejected request: HTTP ${res.status}` };
      }
    } catch (e: any) {
      return { ok: false, requestId: id, error: `network error contacting peer: ${e?.message ?? "unknown"}` };
    }
  }

  return { ok: true, requestId: id, pin, expiresAt: pending.expiresAt };
}

/**
 * TARGET side. Local-only approval — the human types the PIN they received
 * OOB. On success: flip status to "approved" + write trust entry so future
 * requests skip the round-trip.
 */
export async function approveConsent(requestId: string, pin: string): Promise<{ ok: boolean; error?: string; entry?: TrustEntry }> {
  const req = readPending(requestId);
  if (!req) return { ok: false, error: `request not found: ${requestId}` };
  if (req.status !== "pending") return { ok: false, error: `request is ${req.status}, cannot approve` };
  if (!verifyPin(pin, req.pinHash)) return { ok: false, error: "PIN mismatch" };

  updateStatus(requestId, "approved");

  const entry: TrustEntry = {
    from: req.from,
    to: req.to,
    action: req.action,
    approvedAt: new Date().toISOString(),
    approvedBy: "human",
    requestId,
  };
  recordTrust(entry);
  return { ok: true, entry };
}

/**
 * TARGET-side reject. Marks the pending request rejected without writing
 * trust. Phase 2 will surface this to the initiator; Phase 1 just records
 * locally for audit.
 */
export function rejectConsent(requestId: string): { ok: boolean; error?: string } {
  const req = readPending(requestId);
  if (!req) return { ok: false, error: `request not found: ${requestId}` };
  if (req.status !== "pending") return { ok: false, error: `request is ${req.status}, cannot reject` };
  updateStatus(requestId, "rejected");
  return { ok: true };
}
