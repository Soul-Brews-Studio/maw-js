/**
 * Consent primitive tests (#644 Phase 1).
 *
 * Each test isolates state via env-overridden paths under a per-test tmpdir,
 * so the suite never touches the real ~/.maw/{trust,consent-pending}.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  generatePin, hashPin, verifyPin,
  isTrusted, recordTrust, removeTrust, listTrust, trustKey,
  writePending, readPending, listPending, updateStatus, applyExpiry,
  requestConsent, approveConsent, rejectConsent, newRequestId,
} from "../../../src/core/consent";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "consent-test-"));
  process.env.CONSENT_TRUST_FILE = join(workdir, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(workdir, "consent-pending");
});

afterEach(() => {
  delete process.env.CONSENT_TRUST_FILE;
  delete process.env.CONSENT_PENDING_DIR;
  rmSync(workdir, { recursive: true, force: true });
});

// ---------- pin.ts ----------

describe("generatePin", () => {
  it("produces 6-char strings from the pair-code alphabet", () => {
    const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 50; i++) {
      const pin = generatePin();
      expect(pin.length).toBe(6);
      for (const ch of pin) expect(ALPHABET).toContain(ch);
    }
  });

  it("does not collide trivially over 100 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePin());
    // 100 draws from 32^6 (~1B) space — collision would indicate broken RNG
    expect(seen.size).toBeGreaterThan(95);
  });
});

describe("hashPin / verifyPin", () => {
  it("hashPin is deterministic on normalized input", () => {
    const h1 = hashPin("ABC-DEF");
    const h2 = hashPin("abcdef");
    const h3 = hashPin("ABCDEF");
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it("verifyPin accepts the original pin", () => {
    const pin = generatePin();
    expect(verifyPin(pin, hashPin(pin))).toBe(true);
  });

  it("verifyPin rejects a different pin", () => {
    expect(verifyPin("AAAAAA", hashPin("BBBBBB"))).toBe(false);
  });

  it("verifyPin rejects malformed shapes (length / alphabet)", () => {
    const h = hashPin("ABCDEF");
    expect(verifyPin("ABCDE", h)).toBe(false);   // too short
    expect(verifyPin("ABCDEFG", h)).toBe(false); // too long
    expect(verifyPin("ABCDE0", h)).toBe(false);  // 0 not in alphabet
  });
});

// ---------- store.ts: trust ----------

describe("trust store", () => {
  it("isTrusted returns false on empty store", () => {
    expect(isTrusted("a", "b", "hey")).toBe(false);
  });

  it("recordTrust → isTrusted round-trip", () => {
    recordTrust({
      from: "neo", to: "mawjs", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: "r1",
    });
    expect(isTrusted("neo", "mawjs", "hey")).toBe(true);
    expect(isTrusted("mawjs", "neo", "hey")).toBe(false); // asymmetric
    expect(isTrusted("neo", "mawjs", "team-invite")).toBe(false); // per-action
  });

  it("removeTrust deletes the entry", () => {
    recordTrust({ from: "a", to: "b", action: "hey", approvedAt: "x", approvedBy: "human", requestId: null });
    expect(removeTrust("a", "b", "hey")).toBe(true);
    expect(isTrusted("a", "b", "hey")).toBe(false);
    expect(removeTrust("a", "b", "hey")).toBe(false); // already gone
  });

  it("listTrust returns sorted by approvedAt", () => {
    recordTrust({ from: "a", to: "b", action: "hey", approvedAt: "2026-01-02", approvedBy: "human", requestId: null });
    recordTrust({ from: "c", to: "d", action: "hey", approvedAt: "2026-01-01", approvedBy: "human", requestId: null });
    const list = listTrust();
    expect(list.map(e => e.from)).toEqual(["c", "a"]);
  });

  it("trustKey is the canonical join", () => {
    expect(trustKey("a", "b", "hey")).toBe("a→b:hey");
  });

  it("survives missing file (fresh install)", () => {
    expect(listTrust()).toEqual([]);
  });

  it("survives corrupt file (bad JSON)", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.CONSENT_TRUST_FILE!, "{not json");
    expect(listTrust()).toEqual([]);
    // Should still accept new writes after a corrupt read
    recordTrust({ from: "x", to: "y", action: "hey", approvedAt: "z", approvedBy: "human", requestId: null });
    expect(isTrusted("x", "y", "hey")).toBe(true);
  });

  it("survives wrong-shape file (peers:[] instead of peers:{})", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(process.env.CONSENT_TRUST_FILE!, JSON.stringify({ version: 1, trust: [] }));
    expect(listTrust()).toEqual([]);
  });
});

// ---------- store.ts: pending ----------

function mkPending(over: Partial<Parameters<typeof writePending>[0]> = {}) {
  const now = Date.now();
  return {
    id: over.id ?? "abc",
    from: over.from ?? "neo",
    to: over.to ?? "mawjs",
    action: (over.action ?? "hey") as const,
    summary: over.summary ?? "test",
    pinHash: over.pinHash ?? hashPin("ABCDEF"),
    createdAt: over.createdAt ?? new Date(now).toISOString(),
    expiresAt: over.expiresAt ?? new Date(now + 60_000).toISOString(),
    status: over.status ?? ("pending" as const),
  };
}

describe("pending store", () => {
  it("write/read round-trip", () => {
    writePending(mkPending());
    const r = readPending("abc");
    expect(r?.id).toBe("abc");
    expect(r?.summary).toBe("test");
  });

  it("readPending returns null for missing id", () => {
    expect(readPending("nope")).toBeNull();
  });

  it("listPending returns sorted by createdAt desc", () => {
    writePending(mkPending({ id: "old", createdAt: "2026-01-01T00:00:00Z" }));
    writePending(mkPending({ id: "new", createdAt: "2026-02-01T00:00:00Z" }));
    expect(listPending().map(r => r.id)).toEqual(["new", "old"]);
  });

  it("updateStatus persists", () => {
    writePending(mkPending());
    updateStatus("abc", "approved");
    expect(readPending("abc")?.status).toBe("approved");
  });

  it("applyExpiry flips pending → expired past TTL", () => {
    const past = Date.now() - 60_000;
    const r = mkPending({ expiresAt: new Date(past).toISOString() });
    expect(applyExpiry(r).status).toBe("expired");
  });

  it("applyExpiry preserves non-pending statuses", () => {
    const past = Date.now() - 60_000;
    const r = mkPending({ status: "approved", expiresAt: new Date(past).toISOString() });
    expect(applyExpiry(r).status).toBe("approved");
  });

  it("on-disk file does not contain plaintext PIN", () => {
    const pin = "ABCDEF";
    writePending(mkPending({ pinHash: hashPin(pin) }));
    const path = join(process.env.CONSENT_PENDING_DIR!, "abc.json");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain(pin);
  });
});

// ---------- request.ts ----------

describe("requestConsent (no peerUrl)", () => {
  it("returns PIN + id and writes pending mirror", async () => {
    const r = await requestConsent({
      from: "neo", to: "mawjs", action: "hey", summary: "hello",
    });
    expect(r.ok).toBe(true);
    expect(r.pin).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.requestId).toBeTruthy();
    expect(readPending(r.requestId!)?.summary).toBe("hello");
  });
});

describe("requestConsent (with peerUrl + mock fetch)", () => {
  it("posts to /api/consent/request", async () => {
    let captured: { url: string; init: any } | null = null;
    const fakeFetch: any = async (url: any, init: any) => {
      captured = { url: String(url), init };
      return { ok: true, status: 201 } as Response;
    };
    const r = await requestConsent({
      from: "neo", to: "mawjs", action: "hey", summary: "hi",
      peerUrl: "http://peer:3456", fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(captured!.url).toBe("http://peer:3456/api/consent/request");
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body);
    expect(body.from).toBe("neo");
    expect(body.action).toBe("hey");
    expect(body.pinHash).toBeTruthy();
    expect(body.pin).toBeUndefined(); // never wire the plaintext
  });

  it("returns ok:false on peer HTTP error but still mirrors locally", async () => {
    const fakeFetch: any = async () => ({ ok: false, status: 500 } as Response);
    const r = await requestConsent({
      from: "neo", to: "mawjs", action: "hey", summary: "hi",
      peerUrl: "http://peer:3456", fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("500");
    expect(readPending(r.requestId!)).not.toBeNull();
  });

  it("returns ok:false on network error", async () => {
    const fakeFetch: any = async () => { throw new Error("ECONNREFUSED"); };
    const r = await requestConsent({
      from: "neo", to: "mawjs", action: "hey", summary: "hi",
      peerUrl: "http://peer:3456", fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });
});

describe("approveConsent", () => {
  it("happy path: approves + writes trust + flips status", async () => {
    const r = await requestConsent({ from: "neo", to: "mawjs", action: "hey", summary: "x" });
    const id = r.requestId!;
    const pin = r.pin!;

    const ap = await approveConsent(id, pin);
    expect(ap.ok).toBe(true);
    expect(ap.entry?.from).toBe("neo");
    expect(isTrusted("neo", "mawjs", "hey")).toBe(true);
    expect(readPending(id)?.status).toBe("approved");
  });

  it("rejects unknown id", async () => {
    const r = await approveConsent("nope", "ABCDEF");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  it("rejects wrong PIN — no trust written", async () => {
    const r = await requestConsent({ from: "a", to: "b", action: "hey", summary: "x" });
    const ap = await approveConsent(r.requestId!, "ZZZZZZ");
    expect(ap.ok).toBe(false);
    expect(ap.error).toContain("PIN");
    expect(isTrusted("a", "b", "hey")).toBe(false);
  });

  it("rejects approval after expiry", async () => {
    const r = await requestConsent({ from: "a", to: "b", action: "hey", summary: "x" });
    // Force-expire the on-disk record
    const rec = readPending(r.requestId!)!;
    writePending({ ...rec, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const ap = await approveConsent(r.requestId!, r.pin!);
    expect(ap.ok).toBe(false);
    expect(ap.error).toContain("expired");
  });

  it("cannot double-approve", async () => {
    const r = await requestConsent({ from: "a", to: "b", action: "hey", summary: "x" });
    await approveConsent(r.requestId!, r.pin!);
    const second = await approveConsent(r.requestId!, r.pin!);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("approved");
  });
});

describe("rejectConsent", () => {
  it("flips to rejected — no trust written", async () => {
    const r = await requestConsent({ from: "a", to: "b", action: "hey", summary: "x" });
    expect(rejectConsent(r.requestId!).ok).toBe(true);
    expect(readPending(r.requestId!)?.status).toBe("rejected");
    expect(isTrusted("a", "b", "hey")).toBe(false);
  });
});

describe("newRequestId", () => {
  it("produces unique 24-char hex strings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newRequestId();
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});
