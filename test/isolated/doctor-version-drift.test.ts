/**
 * maw doctor — version drift check (#638).
 *
 * Compares source `package.json` version to each running maw process's
 * `/info` endpoint `version` field. MVP covers pm2 only.
 *
 * Covered branches (see src/commands/plugins/doctor/impl.ts):
 *   - pm2 unavailable (execSync throws / non-JSON)   → ok, "pm2 unavailable"
 *   - pm2 available, no maw process                  → ok, "no running maw"
 *   - pm2 has maw, /info aligned                     → ok, "aligned"
 *   - pm2 has maw, /info drift                       → NOT ok, "drift"
 *   - pm2 has maw, /info unreachable                 → NOT ok, "unreachable"
 *   - --allow-drift gate flips drift-only fail → ok true
 *   - args=['version'] runs only version checks
 *
 * Isolated: we mock `child_process.execSync` + global `fetch`. Real refs
 * captured before mocks are installed, per the #429 / fleet-doctor pattern.
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Gate so tests-not-using-the-mock fall through to real impls.
let mockActive = false;

// Capture real refs BEFORE mocks.
const realChildProcess = await import("child_process");
const realFetch = globalThis.fetch;

// Mutable controls per-test.
let pm2Behavior: { kind: "throw"; err: Error } | { kind: "return"; json: unknown } | { kind: "raw"; value: string } =
  { kind: "return", json: [] };

let fetchBehavior: {
  status: number;
  body: unknown;
  throws?: Error;
} = { status: 200, body: {} };
let fetchCalls: Array<{ url: string }> = [];

// ─── Install mocks ──────────────────────────────────────────────────────────

await mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string, opts?: unknown): Buffer | string => {
    if (!mockActive) return realChildProcess.execSync(cmd, opts as never);
    if (typeof cmd === "string" && cmd.includes("pm2 jlist")) {
      if (pm2Behavior.kind === "throw") throw pm2Behavior.err;
      if (pm2Behavior.kind === "raw") return pm2Behavior.value;
      return JSON.stringify(pm2Behavior.json);
    }
    // Pass anything else through; avoids loops for unrelated calls.
    return realChildProcess.execSync(cmd, opts as never);
  },
}));

// Swap global fetch with a per-test stub.
(globalThis as any).fetch = async (url: any, _init?: any) => {
  if (!mockActive) return realFetch(url, _init);
  fetchCalls.push({ url: String(url) });
  if (fetchBehavior.throws) throw fetchBehavior.throws;
  const body = fetchBehavior.body;
  return {
    ok: fetchBehavior.status >= 200 && fetchBehavior.status < 300,
    status: fetchBehavior.status,
    json: async () => body,
  } as any;
};

// Import target after mocks.
const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");

// Read the real source version once — the impl uses the real fs to read it.
const SRC_VERSION: string = (() => {
  const pkgPath = join(import.meta.dir, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return String(pkg.version);
})();

// Silence the renderer.
const origLog = console.log;
async function run<T>(fn: () => Promise<T>): Promise<T> {
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = origLog; }
}

beforeEach(() => {
  mockActive = true;
  pm2Behavior = { kind: "return", json: [] };
  fetchBehavior = { status: 200, body: {} };
  fetchCalls = [];
});
afterEach(() => { mockActive = false; });
afterAll(() => {
  mockActive = false;
  console.log = origLog;
  (globalThis as any).fetch = realFetch;
});

// ════════════════════════════════════════════════════════════════════════════

describe("cmdDoctor version — pm2 branch coverage", () => {
  test("pm2 unavailable (execSync throws) → ok true, 'pm2 unavailable' message", async () => {
    pm2Behavior = { kind: "throw", err: new Error("pm2: command not found") };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0].name).toBe("version:pm2");
    expect(out.checks[0].ok).toBe(true);
    expect(out.checks[0].message).toContain("pm2 unavailable");
    expect(fetchCalls).toHaveLength(0);
  });

  test("pm2 returns non-JSON → ok true, 'pm2 unavailable' message", async () => {
    pm2Behavior = { kind: "raw", value: "not json" };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    expect(out.checks[0].name).toBe("version:pm2");
    expect(out.checks[0].message).toContain("pm2 unavailable");
  });

  test("pm2 returns empty array → ok true, 'no running maw' message", async () => {
    pm2Behavior = { kind: "return", json: [] };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    expect(out.checks[0].name).toBe("version:pm2");
    expect(out.checks[0].message).toContain("no running maw");
    expect(out.checks[0].message).toContain(SRC_VERSION);
  });

  test("pm2 has only non-maw procs → ok true, 'no running maw'", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "nginx", pm_id: 0, pm2_env: { status: "online" } },
      { name: "postgres", pm_id: 1, pm2_env: { status: "online" } },
    ]};

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    expect(out.checks[0].message).toContain("no running maw");
  });
});

describe("cmdDoctor version — drift states", () => {
  test("pm2 has maw + /info aligned → ok true, 'aligned'", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 3, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 200, body: { version: SRC_VERSION } };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    const vc = out.checks.find(c => c.name === "version:maw#3")!;
    expect(vc).toBeDefined();
    expect(vc.ok).toBe(true);
    expect(vc.message).toContain("aligned");
    expect(vc.message).toContain(SRC_VERSION);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://localhost:3456/info");
  });

  test("pm2 has maw + /info drift → ok false, 'drift'", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 3, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 200, body: { version: "0.0.0-stale" } };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(false);
    const vc = out.checks.find(c => c.name === "version:maw#3")!;
    expect(vc.ok).toBe(false);
    expect(vc.message).toContain("drift");
    expect(vc.message).toContain("0.0.0-stale");
    expect(vc.message).toContain(SRC_VERSION);
  });

  test("pm2 has maw but /info unreachable (fetch throws) → ok false, 'unreachable'", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 0, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 500, body: {}, throws: new Error("ECONNREFUSED") };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(false);
    const vc = out.checks.find(c => c.name === "version:maw#0")!;
    expect(vc.ok).toBe(false);
    expect(vc.message).toContain("unreachable");
  });

  test("pm2 has maw but /info returns HTTP 500 → ok false, 'unreachable'", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 7, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 500, body: {} };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(false);
    const vc = out.checks.find(c => c.name === "version:maw#7")!;
    expect(vc.ok).toBe(false);
    expect(vc.message).toContain("unreachable");
  });

  test("maw-* named processes are included", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw-secondary", pm_id: 5, pm2_env: { env: { MAW_PORT: "3457" } } },
    ]};
    fetchBehavior = { status: 200, body: { version: SRC_VERSION } };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(true);
    const vc = out.checks.find(c => c.name === "version:maw-secondary#5")!;
    expect(vc).toBeDefined();
    expect(vc.ok).toBe(true);
    expect(fetchCalls[0].url).toBe("http://localhost:3457/info");
  });
});

describe("cmdDoctor version — --allow-drift flag", () => {
  test("drift without --allow-drift → ok false", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 0, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 200, body: { version: "0.0.0-stale" } };

    const out = await run(() => cmdDoctor(["version"]));

    expect(out.ok).toBe(false);
  });

  test("drift with --allow-drift → ok true (individual check still ok:false)", async () => {
    pm2Behavior = { kind: "return", json: [
      { name: "maw", pm_id: 0, pm2_env: { env: { MAW_PORT: "3456" } } },
    ]};
    fetchBehavior = { status: 200, body: { version: "0.0.0-stale" } };

    const out = await run(() => cmdDoctor(["version", "--allow-drift"]));

    expect(out.ok).toBe(true);
    const vc = out.checks.find(c => c.name === "version:maw#0")!;
    expect(vc.ok).toBe(false);
    expect(vc.message).toContain("drift");
  });
});
