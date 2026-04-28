/**
 * api-identity-fields.test.ts — #804 Step 1.
 *
 * Pinpoint test: GET /api/identity must return all 7 contract fields as the
 * federation peer-identity ADR (docs/federation/0001-peer-identity.md) lays
 * down: node, version, agents, clockUtc, uptime, endpoints, pubkey.
 *
 * Isolated because the handler's `pubkey` reads from <CONFIG_DIR>/peer-key,
 * and CONFIG_DIR is captured at paths.ts import time. We pin MAW_HOME to a
 * tmp dir before importing federation.ts so the test can't touch the
 * operator's real key.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";

const TEST_HOME = mkdtempSync(join(tmpdir(), "maw-api-identity-804-"));
process.env.MAW_HOME = TEST_HOME;
mkdirSync(join(TEST_HOME, "config", "fleet"), { recursive: true });
delete process.env.MAW_PEER_KEY;
delete process.env.MAW_JWT_SECRET;

let app: Elysia;

beforeAll(async () => {
  const { federationApi } = await import("../../src/api/federation");
  app = new Elysia().use(federationApi);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.MAW_HOME;
});

describe("GET /api/identity — #804 Step 1 contract", () => {
  test("returns 200 with application/json", async () => {
    const res = await app.handle(new Request("http://localhost/identity"));
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") || "").toLowerCase()).toContain(
      "application/json",
    );
  });

  test("body has all 7 contract fields with correct types", async () => {
    const res = await app.handle(new Request("http://localhost/identity"));
    const body = (await res.json()) as Record<string, unknown>;

    // 5 pre-existing fields (must not regress).
    expect(typeof body.node).toBe("string");
    expect((body.node as string).length).toBeGreaterThan(0);
    expect(typeof body.version).toBe("string");
    expect(Array.isArray(body.agents)).toBe(true);
    expect(typeof body.clockUtc).toBe("string");
    expect(typeof body.uptime).toBe("number");

    // 2 new fields (#804 Step 1).
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(typeof body.pubkey).toBe("string");
  });

  test("clockUtc is a valid ISO-8601 timestamp", async () => {
    const res = await app.handle(new Request("http://localhost/identity"));
    const body = (await res.json()) as { clockUtc: string };
    const parsed = new Date(body.clockUtc);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  test("endpoints contains the federation write paths from the ADR", async () => {
    const res = await app.handle(new Request("http://localhost/identity"));
    const body = (await res.json()) as { endpoints: string[] };
    // ADR docs/federation/0001-peer-identity.md lists these as the canonical
    // peer-write endpoints; their advertisement is the whole point of Step 1.
    expect(body.endpoints).toContain("/api/send");
    expect(body.endpoints).toContain("/api/wake");
    expect(body.endpoints).toContain("/api/sleep");
    expect(body.endpoints).toContain("/api/pane-keys");
    expect(body.endpoints).toContain("/api/probe");
  });

  test("pubkey is the persisted 64-char hex peer key", async () => {
    const res = await app.handle(new Request("http://localhost/identity"));
    const body = (await res.json()) as { pubkey: string };
    expect(body.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two consecutive calls return the same pubkey (persistence)", async () => {
    const r1 = await app.handle(new Request("http://localhost/identity"));
    const r2 = await app.handle(new Request("http://localhost/identity"));
    const b1 = (await r1.json()) as { pubkey: string };
    const b2 = (await r2.json()) as { pubkey: string };
    expect(b1.pubkey).toBe(b2.pubkey);
  });
});
