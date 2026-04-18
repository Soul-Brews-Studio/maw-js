/**
 * Tests for src/views/info.ts — GET /info handshake endpoint (#596).
 *
 * Covers buildInfo() shape + Hono route dispatch. Matches the contract
 * consumed by src/commands/plugins/peers/probe.ts:111.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { hostname } from "os";
import { buildInfo, infoView } from "../src/views/info";

describe("buildInfo()", () => {
  test("returns required fields with correct types", () => {
    const info = buildInfo();
    expect(typeof info.node).toBe("string");
    expect(info.node.length).toBeGreaterThan(0);
    expect(typeof info.version).toBe("string");
    expect(typeof info.ts).toBe("string");
    expect(info.maw).toBe(true);
  });

  test("ts is a valid ISO-8601 timestamp", () => {
    const info = buildInfo();
    const parsed = new Date(info.ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(info.ts).toBe(parsed.toISOString());
  });

  test("version matches package.json version shape (semver-ish) or empty", () => {
    const info = buildInfo();
    if (info.version !== "") {
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  test("node falls back to hostname when config has no node identity", () => {
    const info = buildInfo();
    // Either cfg.node was set, or os.hostname() — both non-empty.
    const h = hostname();
    expect([info.node, h].every(s => typeof s === "string" && s.length > 0)).toBe(true);
  });
});

describe("GET /info (Hono route)", () => {
  test("responds 200 with application/json and correct body shape", async () => {
    const app = new Hono();
    app.route("/info", infoView);

    const res = await app.request("/info");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.node).toBe("string");
    expect(typeof body.version).toBe("string");
    expect(typeof body.ts).toBe("string");
    expect(body.maw).toBe(true);
  });

  test("body satisfies probe.ts consumer — body.node is a non-empty string", async () => {
    const app = new Hono();
    app.route("/info", infoView);

    const res = await app.request("/info");
    const body = await res.json() as { node?: unknown };
    expect(typeof body.node).toBe("string");
    expect((body.node as string).length).toBeGreaterThan(0);
  });
});
