/**
 * Consent API tests (#644 Phase 1).
 *
 * Drives the Elysia consentApi via .handle() rather than spinning a real
 * server — fast, deterministic, no port races. Loopback enforcement is
 * harder to assert here (Elysia .handle synthesizes no socket); we rely
 * on the handler's defensive default ("undefined remote → loopback") and
 * cover the negative case via a unit assertion below.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { consentApi } from "../../../src/api/consent";
import { hashPin, isTrusted, listPending } from "../../../src/core/consent";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "consent-api-"));
  process.env.CONSENT_TRUST_FILE = join(workdir, "trust.json");
  process.env.CONSENT_PENDING_DIR = join(workdir, "consent-pending");
});

afterEach(() => {
  delete process.env.CONSENT_TRUST_FILE;
  delete process.env.CONSENT_PENDING_DIR;
  rmSync(workdir, { recursive: true, force: true });
});

function post(path: string, body: any) {
  return consentApi.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function get(path: string) {
  return consentApi.handle(new Request(`http://localhost${path}`));
}

function mkValidRequest(over: Record<string, any> = {}) {
  const now = Date.now();
  return {
    id: "req1",
    from: "neo",
    to: "mawjs",
    action: "hey",
    summary: "hello mawjs",
    pinHash: hashPin("ABCDEF"),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    status: "pending",
    ...over,
  };
}

describe("POST /consent/request", () => {
  it("201 + persists pending on valid payload", async () => {
    const res = await post("/consent/request", mkValidRequest());
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(listPending().length).toBe(1);
    expect(listPending()[0].id).toBe("req1");
  });

  it("400 on missing field", async () => {
    const bad = mkValidRequest();
    delete (bad as any).pinHash;
    const res = await post("/consent/request", bad);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("pinHash");
  });

  it("400 on unknown action", async () => {
    const res = await post("/consent/request", mkValidRequest({ action: "rm-rf" }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("unknown action");
  });

  it("409 on duplicate id", async () => {
    await post("/consent/request", mkValidRequest());
    const dup = await post("/consent/request", mkValidRequest({ summary: "second" }));
    expect(dup.status).toBe(409);
  });

  it("force-coerces wire status to pending (no pre-approve)", async () => {
    await post("/consent/request", mkValidRequest({ status: "approved" }));
    expect(listPending()[0].status).toBe("pending");
  });
});

describe("GET /consent/:id", () => {
  it("404 unknown id", async () => {
    const res = await get("/consent/missing");
    expect(res.status).toBe(404);
  });

  it("200 + omits pinHash on success", async () => {
    await post("/consent/request", mkValidRequest());
    const res = await get("/consent/req1");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.request.id).toBe("req1");
    expect(body.request.pinHash).toBeUndefined();
  });
});

describe("POST /consent/:id/approve (loopback default in tests)", () => {
  it("approves with correct PIN + writes trust", async () => {
    await post("/consent/request", mkValidRequest());
    const res = await post("/consent/req1/approve", { pin: "ABCDEF" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(isTrusted("neo", "mawjs", "hey")).toBe(true);
  });

  it("400 on wrong PIN", async () => {
    await post("/consent/request", mkValidRequest());
    const res = await post("/consent/req1/approve", { pin: "ZZZZZZ" });
    expect(res.status).toBe(400);
    expect(isTrusted("neo", "mawjs", "hey")).toBe(false);
  });

  it("400 on missing pin", async () => {
    await post("/consent/request", mkValidRequest());
    const res = await post("/consent/req1/approve", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /consent/:id/reject", () => {
  it("rejects pending request", async () => {
    await post("/consent/request", mkValidRequest());
    const res = await post("/consent/req1/reject", {});
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it("400 on unknown id", async () => {
    const res = await post("/consent/nope/reject", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /consent/list", () => {
  it("lists pending", async () => {
    await post("/consent/request", mkValidRequest({ id: "a" }));
    await post("/consent/request", mkValidRequest({ id: "b" }));
    const res = await get("/consent/list");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.pending.length).toBe(2);
  });
});
