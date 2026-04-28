/**
 * Tests for consent store from src/core/consent/store.ts.
 * trustKey + applyExpiry are pure; filesystem ops use env overrides for temp dirs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  trustKey,
  applyExpiry,
  trustPath,
  loadTrust,
  saveTrust,
  recordTrust,
  removeTrust,
  isTrusted,
  listTrust,
  writePending,
  readPending,
  listPending,
  updateStatus,
  deletePending,
  type TrustEntry,
  type PendingRequest,
} from "../../src/core/consent/store";

const tmp = mkdtempSync(join(tmpdir(), "consent-store-"));
const origTrustFile = process.env.CONSENT_TRUST_FILE;
const origPendingDir = process.env.CONSENT_PENDING_DIR;

beforeAll(() => {
  process.env.CONSENT_TRUST_FILE = join(tmp, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(tmp, "pending");
});

afterAll(() => {
  if (origTrustFile) process.env.CONSENT_TRUST_FILE = origTrustFile;
  else delete process.env.CONSENT_TRUST_FILE;
  if (origPendingDir) process.env.CONSENT_PENDING_DIR = origPendingDir;
  else delete process.env.CONSENT_PENDING_DIR;
});

describe("trustKey", () => {
  it("builds from→to:action key", () => {
    expect(trustKey("neo", "pulse", "send")).toBe("neo→pulse:send");
  });

  it("handles different actions", () => {
    expect(trustKey("a", "b", "wake")).toBe("a→b:wake");
    expect(trustKey("a", "b", "exec")).toBe("a→b:exec");
  });

  it("is deterministic", () => {
    expect(trustKey("x", "y", "send")).toBe(trustKey("x", "y", "send"));
  });

  it("differs for different from/to", () => {
    expect(trustKey("a", "b", "send")).not.toBe(trustKey("b", "a", "send"));
  });
});

describe("applyExpiry", () => {
  it("marks pending request as expired when past expiresAt", () => {
    const req = {
      id: "test",
      from: "a",
      to: "b",
      action: "send" as const,
      status: "pending" as const,
      createdAt: 1000,
      expiresAt: 2000,
    };
    const result = applyExpiry(req, 3000);
    expect(result.status).toBe("expired");
  });

  it("keeps pending when not expired", () => {
    const req = {
      id: "test",
      from: "a",
      to: "b",
      action: "send" as const,
      status: "pending" as const,
      createdAt: 1000,
      expiresAt: 5000,
    };
    const result = applyExpiry(req, 3000);
    expect(result.status).toBe("pending");
  });

  it("does not change non-pending status", () => {
    const req = {
      id: "test",
      from: "a",
      to: "b",
      action: "send" as const,
      status: "approved" as const,
      createdAt: 1000,
      expiresAt: 2000,
    };
    const result = applyExpiry(req, 3000);
    expect(result.status).toBe("approved");
  });
});

// ─── trustPath (env override) ───────────────────────────────────────────────

describe("trustPath", () => {
  it("uses CONSENT_TRUST_FILE env", () => {
    expect(trustPath()).toBe(join(tmp, "trust.json"));
  });
});

// ─── loadTrust + saveTrust (filesystem) ─────────────────────────────────────

describe("loadTrust + saveTrust", () => {
  it("returns empty trust when file missing", () => {
    const trust = loadTrust();
    expect(trust.version).toBe(1);
    expect(Object.keys(trust.trust)).toHaveLength(0);
  });

  it("round-trips trust data", () => {
    const entry: TrustEntry = {
      from: "nodeA", to: "nodeB", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: "r1",
    };
    saveTrust({ version: 1, trust: { [trustKey("nodeA", "nodeB", "hey")]: entry } });
    const loaded = loadTrust();
    expect(loaded.trust["nodeA→nodeB:hey"].from).toBe("nodeA");
  });

  it("returns empty trust for malformed JSON", () => {
    writeFileSync(trustPath(), "not json");
    expect(Object.keys(loadTrust().trust)).toHaveLength(0);
  });

  it("returns empty trust for array JSON", () => {
    writeFileSync(trustPath(), "[1,2]");
    expect(Object.keys(loadTrust().trust)).toHaveLength(0);
  });
});

// ─── recordTrust + isTrusted + removeTrust ──────────────────────────────────

describe("recordTrust + isTrusted + removeTrust", () => {
  beforeEach(() => saveTrust({ version: 1, trust: {} }));

  it("records and checks trust", () => {
    expect(isTrusted("a", "b", "hey")).toBe(false);
    recordTrust({
      from: "a", to: "b", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "human", requestId: null,
    });
    expect(isTrusted("a", "b", "hey")).toBe(true);
  });

  it("removes trust", () => {
    recordTrust({
      from: "a", to: "b", action: "hey",
      approvedAt: new Date().toISOString(), approvedBy: "auto", requestId: null,
    });
    expect(removeTrust("a", "b", "hey")).toBe(true);
    expect(isTrusted("a", "b", "hey")).toBe(false);
  });

  it("removeTrust returns false for missing", () => {
    expect(removeTrust("x", "y", "hey")).toBe(false);
  });

  it("listTrust returns sorted by approvedAt", () => {
    recordTrust({
      from: "b", to: "c", action: "hey",
      approvedAt: "2026-01-02T00:00:00Z", approvedBy: "human", requestId: null,
    });
    recordTrust({
      from: "a", to: "b", action: "hey",
      approvedAt: "2026-01-01T00:00:00Z", approvedBy: "human", requestId: null,
    });
    const list = listTrust();
    expect(list[0].from).toBe("a");
    expect(list[1].from).toBe("b");
  });
});

// ─── Pending requests (filesystem) ──────────────────────────────────────────

describe("pending requests", () => {
  function makePending(id: string): PendingRequest {
    return {
      id, from: "nodeA", to: "nodeB", action: "hey",
      summary: "test", pinHash: "hash123",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      status: "pending",
    };
  }

  it("write + read round-trips", () => {
    writePending(makePending("c1"));
    const read = readPending("c1");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("c1");
    expect(read!.from).toBe("nodeA");
  });

  it("readPending returns null for missing", () => {
    expect(readPending("nonexistent")).toBeNull();
  });

  it("listPending returns sorted by createdAt desc", () => {
    writePending({ ...makePending("c2"), createdAt: "2026-01-01T00:00:00Z" });
    writePending({ ...makePending("c3"), createdAt: "2026-01-02T00:00:00Z" });
    const list = listPending();
    const ids = list.map(p => p.id);
    expect(ids.indexOf("c3")).toBeLessThan(ids.indexOf("c2"));
  });

  it("updateStatus changes status", () => {
    writePending(makePending("c4"));
    expect(updateStatus("c4", "approved")).toBe(true);
    expect(readPending("c4")!.status).toBe("approved");
  });

  it("updateStatus returns false for missing", () => {
    expect(updateStatus("nonexistent", "approved")).toBe(false);
  });

  it("deletePending removes file", () => {
    writePending(makePending("c5"));
    expect(deletePending("c5")).toBe(true);
    expect(readPending("c5")).toBeNull();
  });

  it("deletePending returns false for missing", () => {
    expect(deletePending("nonexistent")).toBe(false);
  });

  it("readPending auto-expires past-due requests", () => {
    const req = makePending("c6");
    req.expiresAt = new Date(Date.now() - 1000).toISOString();
    writePending(req);
    expect(readPending("c6")!.status).toBe("expired");
  });
});
