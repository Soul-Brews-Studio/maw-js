/**
 * Regression test for #484 — PUT /config-file must be atomic (O_CREAT | O_EXCL).
 *
 * The old handler used `existsSync` guard followed by `writeFileSync` — a
 * TOCTOU window where two concurrent requests for the same filename could
 * both pass the guard and both write, silently bypassing the 409 constraint.
 *
 * The fix uses `writeFileSync(..., { flag: "wx" })`, which maps to O_CREAT |
 * O_EXCL: the kernel rejects atomically if the file already exists.
 *
 * Isolated (per-file subprocess) because we mutate process.env before a
 * module-load that reads it — poisons other tests otherwise.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Elysia } from "elysia";

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-config-484-"));
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;

let app: Elysia;
let fleetDir: string;

beforeAll(async () => {
  const paths = await import("../../src/core/paths");
  fleetDir = paths.FLEET_DIR;
  const { configApi } = await import("../../src/api/config");
  app = new Elysia().use(configApi);
});

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

function put(name: string, content: string) {
  return app.handle(
    new Request("http://localhost/config-file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, content }),
    }),
  );
}

describe("PUT /config-file (atomic creation, #484)", () => {
  test("first PUT creates the file; second PUT for same name returns 409", async () => {
    const name = "serial-484.json";
    const first = await put(name, JSON.stringify({ a: 1 }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, path: `fleet/${name}` });

    const second = await put(name, JSON.stringify({ b: 2 }));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "file already exists" });

    // Original content is preserved — second PUT did not overwrite.
    const written = readFileSync(join(fleetDir, name), "utf-8");
    expect(JSON.parse(written)).toEqual({ a: 1 });
  });

  test("concurrent PUTs for the same name: exactly one wins, others 409", async () => {
    const name = "concurrent-484.json";
    const N = 20;
    const payloads = Array.from({ length: N }, (_, i) =>
      JSON.stringify({ writer: i }),
    );

    // Fire them off in parallel — this is the TOCTOU race.
    const responses = await Promise.all(payloads.map((p) => put(name, p)));
    const statuses = responses.map((r) => r.status).sort();

    const wins = statuses.filter((s) => s === 200).length;
    const losses = statuses.filter((s) => s === 409).length;

    // Exactly one winner. The TOCTOU bug would let 2+ through.
    expect(wins).toBe(1);
    expect(losses).toBe(N - 1);

    // Exactly one file on disk with that name, and its content matches
    // one of the payloads (whichever writer won the race).
    const written = readFileSync(join(fleetDir, name), "utf-8");
    const parsed = JSON.parse(written);
    expect(parsed).toHaveProperty("writer");
    expect(typeof parsed.writer).toBe("number");

    const entries = readdirSync(fleetDir).filter((f) => f === name);
    expect(entries).toEqual([name]);
  });

  test("invalid JSON rejected with 400 before any file is created", async () => {
    const name = "invalid-484.json";
    const res = await put(name, "{not json");
    expect(res.status).toBe(400);
    const files = readdirSync(fleetDir).filter((f) => f === name);
    expect(files).toEqual([]);
  });

  test("name must end with .json (400)", async () => {
    const res = await put("not-json-484.txt", JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name must end with .json" });
  });
});
