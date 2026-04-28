/**
 * Tests for requestConsent, approveConsent, rejectConsent from
 * src/core/consent/request.ts — uses env overrides for consent store
 * + fetchImpl DI for network calls.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  requestConsent,
  approveConsent,
  rejectConsent,
  type ConsentRequest,
} from "../../src/core/consent/request";
import {
  readPending,
  listPending,
  loadTrust,
  saveTrust,
  isTrusted,
  type PendingRequest,
} from "../../src/core/consent/store";

const tmp = mkdtempSync(join(tmpdir(), "consent-req-flow-"));
const origTrust = process.env.CONSENT_TRUST_FILE;
const origPending = process.env.CONSENT_PENDING_DIR;

process.env.CONSENT_TRUST_FILE = join(tmp, "trust.json");
process.env.CONSENT_PENDING_DIR = join(tmp, "pending");

afterAll(() => {
  if (origTrust) process.env.CONSENT_TRUST_FILE = origTrust;
  else delete process.env.CONSENT_TRUST_FILE;
  if (origPending) process.env.CONSENT_PENDING_DIR = origPending;
  else delete process.env.CONSENT_PENDING_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear pending dir and trust file
  try { rmSync(join(tmp, "pending"), { recursive: true, force: true }); } catch {}
  saveTrust({ version: 1, trust: {} });
});

// ─── requestConsent ───────────────────────────────────────────────────────────

describe("requestConsent", () => {
  it("returns ok with pin and requestId for local request", async () => {
    const result = await requestConsent({
      from: "neo",
      to: "pulse",
      action: "hey",
      summary: "test request",
    });
    expect(result.ok).toBe(true);
    expect(result.requestId).toBeDefined();
    expect(result.pin).toBeDefined();
    expect(result.pin!).toHaveLength(6);
    expect(result.expiresAt).toBeDefined();
  });

  it("persists pending entry locally", async () => {
    const result = await requestConsent({
      from: "neo",
      to: "pulse",
      action: "hey",
      summary: "persist test",
    });
    const pending = readPending(result.requestId!);
    expect(pending).not.toBeNull();
    expect(pending!.from).toBe("neo");
    expect(pending!.to).toBe("pulse");
    expect(pending!.action).toBe("hey");
    expect(pending!.summary).toBe("persist test");
    expect(pending!.status).toBe("pending");
  });

  it("stores pinHash, not plaintext pin", async () => {
    const result = await requestConsent({
      from: "a",
      to: "b",
      action: "send",
      summary: "hash check",
    });
    const pending = readPending(result.requestId!);
    expect(pending!.pinHash).toBeDefined();
    expect(pending!.pinHash).not.toBe(result.pin);
    expect(pending!.pinHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("generates unique request IDs", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await requestConsent({
        from: "a", to: "b", action: "hey", summary: `req ${i}`,
      });
      ids.add(r.requestId!);
    }
    expect(ids.size).toBe(10);
  });

  it("sets expiresAt ~10 minutes in the future", async () => {
    const before = Date.now();
    const result = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "ttl test",
    });
    const expiresAt = new Date(result.expiresAt!).getTime();
    const tenMin = 10 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + tenMin - 1000);
    expect(expiresAt).toBeLessThan(before + tenMin + 1000);
  });

  it("posts to peer when peerUrl is provided", async () => {
    let postedUrl = "";
    let postedBody: any = null;
    const mockFetch = async (url: any, opts: any) => {
      postedUrl = url.toString();
      postedBody = JSON.parse(opts.body);
      return { ok: true, status: 200 } as Response;
    };

    const result = await requestConsent({
      from: "neo",
      to: "pulse",
      action: "hey",
      summary: "peer post test",
      peerUrl: "http://peer:3456",
      fetchImpl: mockFetch as any,
    });

    expect(result.ok).toBe(true);
    expect(postedUrl).toContain("/api/consent/request");
    expect(postedBody.from).toBe("neo");
    expect(postedBody.to).toBe("pulse");
  });

  it("returns error when peer rejects (HTTP non-ok)", async () => {
    const mockFetch = async () => ({ ok: false, status: 403 } as Response);

    const result = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "rejected",
      peerUrl: "http://peer:3456",
      fetchImpl: mockFetch as any,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("peer rejected");
    expect(result.error).toContain("403");
  });

  it("returns error on network failure", async () => {
    const mockFetch = async () => { throw new Error("connection refused"); };

    const result = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "network fail",
      peerUrl: "http://dead:3456",
      fetchImpl: mockFetch as any,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network error");
    expect(result.error).toContain("connection refused");
  });

  it("still persists locally even when peer fails", async () => {
    const mockFetch = async () => { throw new Error("offline"); };

    const result = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "persist despite fail",
      peerUrl: "http://dead:3456",
      fetchImpl: mockFetch as any,
    });

    expect(result.ok).toBe(false);
    const pending = readPending(result.requestId!);
    expect(pending).not.toBeNull();
    expect(pending!.summary).toBe("persist despite fail");
  });

  it("skips network call when no peerUrl", async () => {
    let fetched = false;
    const mockFetch = async () => { fetched = true; return { ok: true } as Response; };

    await requestConsent({
      from: "a", to: "b", action: "hey", summary: "local only",
      fetchImpl: mockFetch as any,
    });

    expect(fetched).toBe(false);
  });
});

// ─── approveConsent ───────────────────────────────────────────────────────────

describe("approveConsent", () => {
  it("approves with correct PIN", async () => {
    const req = await requestConsent({
      from: "neo", to: "pulse", action: "hey", summary: "approve test",
    });
    const result = await approveConsent(req.requestId!, req.pin!);
    expect(result.ok).toBe(true);
    expect(result.entry).toBeDefined();
    expect(result.entry!.from).toBe("neo");
    expect(result.entry!.to).toBe("pulse");
    expect(result.entry!.action).toBe("hey");
  });

  it("updates pending status to approved", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "send", summary: "status check",
    });
    await approveConsent(req.requestId!, req.pin!);
    const pending = readPending(req.requestId!);
    expect(pending!.status).toBe("approved");
  });

  it("writes trust entry after approval", async () => {
    const req = await requestConsent({
      from: "neo", to: "pulse", action: "hey", summary: "trust write",
    });
    await approveConsent(req.requestId!, req.pin!);
    expect(isTrusted("neo", "pulse", "hey")).toBe(true);
  });

  it("rejects wrong PIN", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "wrong pin",
    });
    const result = await approveConsent(req.requestId!, "ZZZZZZ");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("PIN mismatch");
  });

  it("rejects missing request", async () => {
    const result = await approveConsent("nonexistent-id", "ABCDEF");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects already-approved request", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "double approve",
    });
    await approveConsent(req.requestId!, req.pin!);
    const result = await approveConsent(req.requestId!, req.pin!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("approved");
    expect(result.error).toContain("cannot approve");
  });

  it("sets approvedBy to 'human'", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "approver check",
    });
    const result = await approveConsent(req.requestId!, req.pin!);
    expect(result.entry!.approvedBy).toBe("human");
  });

  it("records requestId in trust entry", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "reqid in trust",
    });
    const result = await approveConsent(req.requestId!, req.pin!);
    expect(result.entry!.requestId).toBe(req.requestId!);
  });
});

// ─── rejectConsent ────────────────────────────────────────────────────────────

describe("rejectConsent", () => {
  it("rejects a pending request", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "reject test",
    });
    const result = rejectConsent(req.requestId!);
    expect(result.ok).toBe(true);
  });

  it("updates status to rejected", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "reject status",
    });
    rejectConsent(req.requestId!);
    const pending = readPending(req.requestId!);
    expect(pending!.status).toBe("rejected");
  });

  it("does not write trust entry", async () => {
    const req = await requestConsent({
      from: "neo", to: "pulse", action: "hey", summary: "no trust on reject",
    });
    rejectConsent(req.requestId!);
    expect(isTrusted("neo", "pulse", "hey")).toBe(false);
  });

  it("rejects missing request", () => {
    const result = rejectConsent("nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("rejects already-rejected request", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "double reject",
    });
    rejectConsent(req.requestId!);
    const result = rejectConsent(req.requestId!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected");
    expect(result.error).toContain("cannot reject");
  });

  it("cannot approve after rejection", async () => {
    const req = await requestConsent({
      from: "a", to: "b", action: "hey", summary: "approve after reject",
    });
    rejectConsent(req.requestId!);
    const result = await approveConsent(req.requestId!, req.pin!);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected");
  });
});

// ─── Full flow ────────────────────────────────────────────────────────────────

describe("consent full flow", () => {
  it("request → approve → trusted", async () => {
    const req = await requestConsent({
      from: "neo", to: "pulse", action: "exec", summary: "full flow",
    });
    expect(req.ok).toBe(true);
    expect(isTrusted("neo", "pulse", "exec")).toBe(false);

    const approve = await approveConsent(req.requestId!, req.pin!);
    expect(approve.ok).toBe(true);
    expect(isTrusted("neo", "pulse", "exec")).toBe(true);
  });

  it("request → reject → not trusted", async () => {
    const req = await requestConsent({
      from: "neo", to: "pulse", action: "wake", summary: "reject flow",
    });
    rejectConsent(req.requestId!);
    expect(isTrusted("neo", "pulse", "wake")).toBe(false);
  });

  it("request with peer success → approve → trusted", async () => {
    const mockFetch = async () => ({ ok: true, status: 200 } as Response);

    const req = await requestConsent({
      from: "neo", to: "pulse", action: "send", summary: "peer flow",
      peerUrl: "http://peer:3456",
      fetchImpl: mockFetch as any,
    });
    expect(req.ok).toBe(true);

    const approve = await approveConsent(req.requestId!, req.pin!);
    expect(approve.ok).toBe(true);
    expect(isTrusted("neo", "pulse", "send")).toBe(true);
  });
});
