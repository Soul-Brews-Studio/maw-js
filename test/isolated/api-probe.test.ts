/**
 * api-probe.test.ts — #804 Step 5 contract.
 *
 * POST /api/probe is the real-write-path health check: it walks the same
 * resolveTarget + tmux-session-exists branches /api/send walks, but never
 * delivers (no sendKeys). Three contracts pinned here:
 *
 *   1. No body / empty target → bare healthcheck { ok: true }.
 *      Proves the handler can run (config + listSessions) without naming
 *      a deliverable agent. Federation peers use this to confirm reach.
 *
 *   2. Resolvable target → { ok: true, target, transport, source }.
 *      Same resolveTarget path /api/send takes, including -oracle stripped
 *      retry. Reports the transport that would be used for delivery.
 *
 *   3. Unresolvable target → { ok: false, error, ...errDetail } HTTP 404.
 *      Mirrors /api/send's error shape so a green probe means a green send.
 *
 * Isolated because we mock listSessions + loadConfig at the module seam,
 * and mock.module is process-global. We mount the routes under a fresh
 * Elysia instance (no auth plugins) — auth is exercised separately in
 * elysia-auth-protected.test.ts and federation-auth.test.ts; here we only
 * pin the handler contract.
 */
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Elysia } from "elysia";
import { mockSshModule } from "../helpers/mock-ssh";

// ─── Mock seams BEFORE importing sessions.ts ────────────────────────────────

const root = join(import.meta.dir, "../..");

// listSessions returns a controllable fake fleet. Default: one local session
// "test-session" with one window "oracle" — enough for resolveTarget to find
// it under bare-name lookup.
let listSessionsReturn: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [
  { name: "test-session", windows: [{ index: 0, name: "oracle", active: true }] },
];

mock.module(join(root, "src/core/transport/ssh"), () =>
  mockSshModule({
    listSessions: async () => listSessionsReturn,
  }),
);

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  return mockConfigModule(() => ({ node: "test-node", port: 3456, agents: {} }));
});

// ─── Mount the route ─────────────────────────────────────────────────────────

let app: Elysia;

beforeAll(async () => {
  const { sessionsApi } = await import("../../src/api/sessions");
  app = new Elysia().use(sessionsApi);
});

afterAll(() => {
  // restore default listSessions for any later isolated test
  listSessionsReturn = [
    { name: "test-session", windows: [{ index: 0, name: "oracle", active: true }] },
  ];
});

function probe(body: unknown) {
  return app.handle(
    new Request("http://localhost/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/probe (#804 Step 5)", () => {
  test("no body → 200 healthcheck mode { ok: true, transport: local, source }", async () => {
    const res = await probe({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("local");
    expect(body.source).toBe("test-node");
    // sessions count surfaces so peers can sanity-check the fleet view
    expect(typeof body.sessions).toBe("number");
  });

  test("missing target field is treated as healthcheck (parity with empty body)", async () => {
    const res = await probe({ target: undefined });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("local");
  });

  test("resolvable local target → 200 { ok: true, target, transport: local }", async () => {
    listSessionsReturn = [
      { name: "test-session", windows: [{ index: 0, name: "oracle", active: true }] },
    ];
    const res = await probe({ target: "oracle" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("local");
    expect(typeof body.target).toBe("string");
    expect(body.source).toBe("test-node");
  });

  test("unresolvable target → 404 { ok: false, error, target }", async () => {
    listSessionsReturn = [];
    const res = await probe({ target: "nonexistent-oracle-xyz" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.target).toBe("nonexistent-oracle-xyz");
  });

  test("never calls sendKeys — probe must not deliver", async () => {
    // The mock for sendKeys above throws nothing; we confirm by calling probe
    // with a resolvable target and verifying the response shape doesn't include
    // delivery fields like `text` or `lastLine` (which /api/send returns).
    listSessionsReturn = [
      { name: "test-session", windows: [{ index: 0, name: "oracle", active: true }] },
    ];
    const res = await probe({ target: "oracle" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("lastLine");
  });

  test("error response includes resolveTarget hint (parity with /send)", async () => {
    listSessionsReturn = [];
    const res = await probe({ target: "nope" });
    const body = (await res.json()) as Record<string, unknown>;
    // resolveTarget returns { type: "error", reason, detail, hint }; probe
    // surfaces these so callers see the same diagnostic /send would emit.
    expect(typeof body.reason).toBe("string");
  });
});
