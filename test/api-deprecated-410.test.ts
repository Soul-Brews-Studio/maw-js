/**
 * Tests for src/api/deprecated.ts — 410 Gone rotation for retired endpoints.
 *
 * Companion to VELA's silent-errors-deprecated-endpoints pattern
 * (~/david-oracle/ψ/memory/vela/patterns/2026-04-18_silent-errors-deprecated-endpoints.md).
 *
 * Verifies Lens 1 (server-side deprecation signal): status 410, migration
 * Link header, Deprecation + Sunset headers, body with replacement path.
 */

import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import { deprecatedApi } from "../src/api/deprecated";

const app = new Elysia({ prefix: "/api" }).use(deprecatedApi);

async function hit(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

describe("deprecated endpoint rotation — 410 Gone", () => {
  test.each([
    ["/api/tokens", "/api/feed"],
    ["/api/tokens/rate", "/api/costs"],
    ["/api/maw-log", "/api/feed"],
  ])("%s → 410 with migration link to %s", async (path, replacement) => {
    const res = await hit(path);

    // Status
    expect(res.status).toBe(410);

    // Headers — Lens 1 signal
    expect(res.headers.get("Link")).toBe(`<${replacement}>; rel="alternate"`);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBe("2026-05-01");

    // Body
    const body: any = await res.json();
    expect(body.error).toBe("removed");
    expect(body.replacement).toBe(replacement);
    expect(body.sunset).toBe("2026-05-01");
    expect(body.message).toContain(replacement);
  });

  test("no more zeroed-stub pattern on /api/tokens/rate", async () => {
    const res = await hit("/api/tokens/rate");
    const body: any = await res.json();
    // Explicit anti-regression: the pre-rotation stub returned
    // { totalTokens: 0, totalPerMin: 0, ... }. If any of those fields
    // reappear, the rotation regressed to the stubbed-corpse pattern.
    expect(body.totalTokens).toBeUndefined();
    expect(body.totalPerMin).toBeUndefined();
    expect(body.turns).toBeUndefined();
  });

  test("no more empty-stub pattern on /api/maw-log", async () => {
    const res = await hit("/api/maw-log");
    const body: any = await res.json();
    // Pre-rotation returned { entries: [], total: 0 }.
    expect(body.entries).toBeUndefined();
    expect(body.total).toBeUndefined();
  });
});
