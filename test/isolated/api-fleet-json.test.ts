/**
 * Regression test for #747 — `/api/fleet` MUST return JSON, never TypeScript
 * type definitions.
 *
 * The bug shape from #747:
 *   curl http://localhost:3456/api/fleet
 *   →  { fleet: [{ file: string, name: string, ... }] }   ❌ types
 *
 * Expected:
 *   →  {"fleet":[{"file":"...","name":"...", ...}]}        ✓ JSON
 *
 * Root-cause class: an Elysia route declared with a schema as the second
 * argument and no handler body causes the validator schema to be serialized
 * into the response. e.g.
 *   api.get("/fleet", { response: t.Object({...}) })   // BAD — no handler
 * vs.
 *   api.get("/fleet", () => ({ fleet: scanFleet() }))   // GOOD — handler
 *
 * This test pins down the contract via in-process `app.handle(req)` so any
 * future regression that returns a non-JSON body, or a body whose values are
 * type strings instead of real data, fails the suite.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";

// FLEET_DIR is captured at module import time from MAW_HOME — set it before
// the dynamic import of federation.ts (which transitively pulls paths.ts).
const TEST_HOME = mkdtempSync(join(tmpdir(), "maw-api-fleet-test-"));
process.env.MAW_HOME = TEST_HOME;

const FLEET_DIR = join(TEST_HOME, "config", "fleet");
mkdirSync(FLEET_DIR, { recursive: true });

// Two sample fleet entries with predictable shape.
const sampleA = {
  name: "alpha-oracle",
  windows: [{ name: "alpha-oracle", repo: "Soul-Brews-Studio/alpha-oracle" }],
  budded_from: "neo-oracle",
};
const sampleB = {
  name: "beta-oracle",
  windows: [{ name: "beta-oracle", repo: "Soul-Brews-Studio/beta-oracle" }],
  budded_from: "alpha-oracle",
};
writeFileSync(join(FLEET_DIR, "alpha-oracle.json"), JSON.stringify(sampleA, null, 2));
writeFileSync(join(FLEET_DIR, "beta-oracle.json"), JSON.stringify(sampleB, null, 2));
// A `.disabled` file should be filtered out by the handler.
writeFileSync(join(FLEET_DIR, "ignored.json.disabled"), JSON.stringify({ name: "ignored" }));

let app: Elysia;

beforeAll(async () => {
  const { federationApi } = await import("../../src/api/federation");
  app = new Elysia().use(federationApi);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.MAW_HOME;
});

describe("GET /api/fleet — #747 regression", () => {
  test("returns 200 with application/json content-type", async () => {
    const res = await app.handle(new Request("http://localhost/fleet"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("application/json");
  });

  test("body is valid JSON (parses without throwing)", async () => {
    const res = await app.handle(new Request("http://localhost/fleet"));
    const text = await res.text();
    // The bug shape — `{ fleet: [{ file: string, ... }] }` — is NOT valid JSON
    // because keys are unquoted and values are bare type identifiers.
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test("body shape: { fleet: Array<object> } with real config data, not type strings", async () => {
    const res = await app.handle(new Request("http://localhost/fleet"));
    const body = (await res.json()) as { fleet: unknown };
    expect(Array.isArray(body.fleet)).toBe(true);

    const fleet = body.fleet as Array<Record<string, unknown>>;
    // Two non-disabled fixture files were written → exactly two entries.
    expect(fleet.length).toBe(2);

    for (const entry of fleet) {
      // `file` and `name` must be real strings from the JSON, NOT the literal
      // type identifier "string". The bug's signature is values like
      // `"file": "string"` instead of `"file": "alpha-oracle.json"`.
      expect(typeof entry.file).toBe("string");
      expect(typeof entry.name).toBe("string");
      expect(entry.file).not.toBe("string");
      expect(entry.name).not.toBe("string");
      expect(entry.file).toMatch(/\.json$/);
    }

    // Verify the actual fixture data is present, not a schema sketch.
    const names = fleet.map(e => e.name).sort();
    expect(names).toEqual(["alpha-oracle", "beta-oracle"]);
  });

  test("filters out *.json.disabled fleet files", async () => {
    const res = await app.handle(new Request("http://localhost/fleet"));
    const body = (await res.json()) as { fleet: Array<{ file: string }> };
    const files = body.fleet.map(e => e.file);
    expect(files).not.toContain("ignored.json.disabled");
    expect(files).not.toContain("ignored.json");
  });

  test("returned text does not contain bare TypeScript type identifiers as values", async () => {
    // Last-line defense: if Elysia or the handler ever serializes a TypeBox
    // schema, the response text will contain unquoted `: string` / `: number`
    // pairs (the type-name leak from #747).
    const res = await app.handle(new Request("http://localhost/fleet"));
    const text = await res.text();
    // JSON always quotes string values: `"file":"alpha-oracle.json"`. The bug
    // produced `file: string` — which is matched by these patterns.
    expect(text).not.toMatch(/:\s*string\b/);
    expect(text).not.toMatch(/:\s*number\b/);
    expect(text).not.toMatch(/:\s*boolean\b/);
  });
});
