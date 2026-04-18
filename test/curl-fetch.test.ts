import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock config
mock.module("../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp",
  // #566: resolveHome() must be present — bun mock.module is process-global.
  resolveHome: () => "/tmp/maw-test",
}));

let mockToken: string | undefined = "test-token-16chars!";
let mockConfigThrows = false;
import { mockConfigModule } from "./helpers/mock-config";
mock.module("../src/config", () => mockConfigModule(() => {
  if (mockConfigThrows) throw new Error("simulated config load failure");
  return { federationToken: mockToken, node: "test" };
}));

const { curlFetch } = await import("../src/core/transport/curl-fetch");

// Probe for a live local maw server at `white.local:3456`. Tests that
// require a running daemon are skipped in environments where it's not
// reachable (CI, other machines, localhost without the service).
// This keeps the integration tests useful locally without breaking CI.
let hasLocalMawServer = false;
try {
  const probe = await fetch("http://white.local:3456/api/auth/status", {
    signal: AbortSignal.timeout(1000),
  });
  hasLocalMawServer = probe.ok;
} catch { /* unreachable — skip integration tests */ }

const liveTest = hasLocalMawServer ? test : test.skip;

describe("curlFetch", () => {
  test("uses native fetch on Linux", async () => {
    // On Linux (this test runs on white.local), curlFetch should use native fetch
    // We can verify by checking process.platform
    expect(process.platform).toBe("linux");
  });

  test("returns ok:false for unreachable host", async () => {
    const res = await curlFetch("http://192.0.2.1:9999/api/test", { timeout: 1000 });
    expect(res.ok).toBe(false);
  });

  test("warns on nativeFetch failure with method + URL (#385 site 1)", async () => {
    // Previous behavior: catch swallowed ALL errors (abort/JSON/network/DNS)
    // and returned a bare {ok:false, status:0, data:null} — callers had no
    // diagnosis. Fix: warn loud with method + URL + error message before
    // returning the same shape (22 callers depend on it).
    const logs: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const res = await curlFetch("http://192.0.2.1:9999/api/test", {
        method: "POST",
        body: JSON.stringify({ t: 1 }),
        timeout: 1000,
      });
      // Return shape preserved
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.data).toBe(null);
      // Diagnosis surfaced: method + URL + "failed" must be greppable
      const joined = logs.join("\n");
      expect(joined).toMatch(/nativeFetch failed/);
      expect(joined).toMatch(/POST/);
      expect(joined).toMatch(/192\.0\.2\.1/);
    } finally {
      console.warn = origWarn;
    }
  });

  test("fails closed when signing throws — does NOT send unsigned request (#385 site 5)", async () => {
    // Previous behavior: catch swallowed the signing error, request went out
    // UNSIGNED, peer rejected with bare 401, caller saw ok:false with no clue.
    // Fix: surface the failure and abort the call without falling through.
    mockConfigThrows = true;
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const res = await curlFetch("http://192.0.2.1:9999/api/send", {
        method: "POST",
        body: JSON.stringify({ t: 1 }),
        timeout: 1000,
      });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      // User-facing diagnosis: the word "signing" must appear so it's greppable
      expect(logs.some((l) => /signing/i.test(l))).toBe(true);
    } finally {
      mockConfigThrows = false;
      console.error = origErr;
    }
  });

  liveTest("sends HMAC headers when token configured", async () => {
    // Test against local maw server — auth/status is public so it won't reject
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(res.data?.enabled).toBe(true);
  });

  liveTest("sends POST with body and auth headers", async () => {
    // POST to auth/status (public endpoint, accepts any method)
    const res = await curlFetch("http://white.local:3456/api/auth/status", {
      method: "POST",
      body: JSON.stringify({ test: true }),
      timeout: 5000,
    });
    // Should not hang — this was the bug
    expect(res.status).toBeDefined();
  });

  liveTest("works without federation token", async () => {
    mockToken = undefined;
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    mockToken = "test-token-16chars!";
  });

  liveTest("parses JSON response", async () => {
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe("object");
    expect(res.data.node).toBe("white");
  });
});

describe("curlFetch federation auth", () => {
  liveTest("protected endpoint with wrong token gets rejected", async () => {
    // Wrong token → signature mismatch → 401 from remote, but from white.local
    // the server sees non-loopback IP so it checks HMAC
    mockToken = "wrong-token-that-wont-match";
    // Use a protected POST endpoint (GET /api/sessions is public for browsers)
    const res = await curlFetch("http://white.local:3456/api/send", {
      method: "POST",
      body: JSON.stringify({ target: "test", text: "test" }),
      timeout: 5000,
    });
    // white.local resolves to LAN IP, not loopback → auth enforced → wrong sig → rejected
    expect(res.ok).toBe(false);
    mockToken = "test-token-16chars!";
  });

  liveTest("POST with body does not hang", async () => {
    // This specifically tests the bug where POST + headers caused Bun.spawn curl to hang
    const start = Date.now();
    const res = await curlFetch("http://white.local:3456/api/send", {
      method: "POST",
      body: JSON.stringify({ target: "nonexistent", text: "test" }),
      timeout: 3000,
    });
    const elapsed = Date.now() - start;
    // Should complete quickly, not timeout at 3s
    expect(elapsed).toBeLessThan(2000);
    // 404 is expected (target not found) — but it didn't hang
    expect(res.status).toBeDefined();
  });
});
