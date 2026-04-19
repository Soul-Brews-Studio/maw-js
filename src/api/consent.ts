/**
 * Consent API — federation HTTP surface (#644 Phase 1).
 *
 *   POST /api/consent/request           — peer receives + persists pending
 *   GET  /api/consent/list              — list pending (loopback only)
 *   GET  /api/consent/:id               — read one pending entry
 *   POST /api/consent/:id/approve       — approve with PIN (loopback only)
 *   POST /api/consent/:id/reject        — reject (loopback only)
 *
 * Auth model:
 *   - /request is intentionally UNAUTHENTICATED. The OOB PIN is the
 *     auth — anyone can submit a request, but only the human at the
 *     target can approve it. Approval requires the PIN.
 *   - /approve, /reject, /list are loopback-only — they're operator
 *     actions, not federation calls. Remote callers get 403.
 *
 * NOTE: this module currently writes to the same on-disk store the CLI
 * uses. That means a request POSTed to a running maw server is visible
 * to `maw consent list` immediately. No daemon-vs-cli sync needed.
 */
import { Elysia } from "elysia";
import {
  type PendingRequest, writePending, readPending, listPending,
  approveConsent, rejectConsent,
} from "../core/consent";

export const consentApi = new Elysia();

function isLoopback(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return true; // local in-process call (no socket)
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1"
    || remoteAddress.startsWith("127.")
    || remoteAddress === "localhost";
}

function clientAddr(server: { requestIP?: (req: Request) => { address?: string } | null } | undefined, request: Request): string | undefined {
  try { return server?.requestIP?.(request)?.address; } catch { return undefined; }
}

// --- POST /consent/request — peer receives a new consent request ---
consentApi.post("/consent/request", async ({ body, set }) => {
  const b = (body ?? {}) as Partial<PendingRequest>;
  const required: (keyof PendingRequest)[] = ["id", "from", "to", "action", "summary", "pinHash", "createdAt", "expiresAt", "status"];
  for (const k of required) {
    if (b[k] === undefined || b[k] === null || b[k] === "") {
      set.status = 400;
      return { ok: false, error: `missing field: ${k}` };
    }
  }
  if (b.action !== "hey" && b.action !== "team-invite" && b.action !== "plugin-install") {
    set.status = 400;
    return { ok: false, error: `unknown action: ${b.action}` };
  }
  const existing = readPending(b.id as string);
  if (existing) {
    set.status = 409;
    return { ok: false, error: "request id already exists" };
  }
  // Force status to "pending" — initiator can't pre-approve via wire payload
  writePending({ ...(b as PendingRequest), status: "pending" });
  set.status = 201;
  return { ok: true, id: b.id, expiresAt: b.expiresAt };
});

// --- GET /consent/list — operator view (loopback-only) ---
consentApi.get("/consent/list", ({ server, request, set }) => {
  if (!isLoopback(clientAddr(server, request))) { set.status = 403; return { ok: false, error: "loopback only" }; }
  return { ok: true, pending: listPending() };
});

// --- GET /consent/:id — public read (initiator polls status here) ---
consentApi.get("/consent/:id", ({ params, set }) => {
  const r = readPending(params.id);
  if (!r) { set.status = 404; return { ok: false, error: "not_found" }; }
  // Never expose the pinHash on a public read — it's a brute-force target.
  const { pinHash: _omit, ...safe } = r;
  return { ok: true, request: safe };
});

// --- POST /consent/:id/approve — operator approves with PIN (loopback) ---
consentApi.post("/consent/:id/approve", async ({ params, body, server, request, set }) => {
  if (!isLoopback(clientAddr(server, request))) { set.status = 403; return { ok: false, error: "loopback only" }; }
  const b = (body ?? {}) as { pin?: string };
  if (typeof b.pin !== "string" || !b.pin) { set.status = 400; return { ok: false, error: "pin required" }; }
  const r = await approveConsent(params.id, b.pin);
  if (!r.ok) { set.status = 400; return r; }
  return { ok: true, entry: r.entry };
});

// --- POST /consent/:id/reject — operator rejects (loopback) ---
consentApi.post("/consent/:id/reject", ({ params, server, request, set }) => {
  if (!isLoopback(clientAddr(server, request))) { set.status = 403; return { ok: false, error: "loopback only" }; }
  const r = rejectConsent(params.id);
  if (!r.ok) { set.status = 400; return r; }
  return { ok: true };
});
