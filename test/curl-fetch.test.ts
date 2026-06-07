import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

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
const origCurlFetchTransport = process.env.MAW_CURL_FETCH_TRANSPORT;
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

const liveTest = process.env.MAW_TEST_LIVE_CURL === "1" && hasLocalMawServer ? test : test.skip;

describe("curlFetch", () => {
  beforeEach(() => {
    mockToken = "test-token-16chars!";
    mockConfigThrows = false;
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
  });

  test("can force native fetch for deterministic unit coverage", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ transport: "native" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;

      const res = await curlFetch("http://example.invalid/native", { timeout: 1000 });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ transport: "native" });
    } finally {
      globalThis.fetch = origFetch;
    }
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
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
    // Test against local maw server — auth/status is public so it won't reject
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(res.data?.enabled).toBe(true);
  });

  liveTest("sends POST with body and auth headers", async () => {
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
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
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
    mockToken = undefined;
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    mockToken = "test-token-16chars!";
  });

  liveTest("parses JSON response", async () => {
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
    const res = await curlFetch("http://white.local:3456/api/auth/status", { timeout: 5000 });
    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe("object");
    expect(res.data.node).toBe("white");
  });
});

describe("curlFetch body size cap (#653)", () => {
  // Tests snapshot global.fetch per-case so they don't leak across the file.
  // Pattern lifted from costs.test.ts fix (#649) to keep snapshot/restore safe.

  beforeEach(() => {
    mockToken = "test-token-16chars!";
    mockConfigThrows = false;
    process.env.MAW_CURL_FETCH_TRANSPORT = "native";
  });

  test("rejects body exceeding maxBytes (streaming)", async () => {
    const origFetch = globalThis.fetch;
    try {
      // Stream 20 chunks of 1 MB each — no Content-Length header, so the
      // cap must fire mid-stream, not up-front.
      globalThis.fetch = (async () => {
        const chunk = new Uint8Array(1024 * 1024);
        let n = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (n++ < 20) { controller.enqueue(chunk); } else { controller.close(); }
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }) as typeof fetch;

      const res = await curlFetch("http://example.invalid/huge", { maxBytes: 1024 * 1024, timeout: 5000 });
      expect(res.ok).toBe(false);
      expect(res.data?.error).toMatch(/body exceeded/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("rejects when Content-Length exceeds cap (before buffering)", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        const hdrs = new Headers({ "content-length": String(50 * 1024 * 1024) });
        return new Response("{}", { status: 200, headers: hdrs });
      }) as typeof fetch;

      const res = await curlFetch("http://example.invalid/declared", { maxBytes: 1024, timeout: 5000 });
      expect(res.ok).toBe(false);
      expect(res.data?.error).toMatch(/body exceeded 1024 bytes/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("passes through when body under cap", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const res = await curlFetch("http://example.invalid/small", { maxBytes: 1024, timeout: 5000 });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ hello: "world" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("default cap is 10 MB when maxBytes not supplied", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        const hdrs = new Headers({ "content-length": String(11 * 1024 * 1024) });
        return new Response("{}", { status: 200, headers: hdrs });
      }) as typeof fetch;

      const res = await curlFetch("http://example.invalid/default", { timeout: 5000 });
      expect(res.ok).toBe(false);
      // 10 MB == 10485760 bytes
      expect(res.data?.error).toMatch(/body exceeded 10485760 bytes/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});


describe("curlFetch curl subprocess transport", () => {
  beforeEach(() => {
    mockToken = undefined;
    mockConfigThrows = false;
    process.env.MAW_CURL_FETCH_TRANSPORT = "curl";
  });

  test("parses successful curl stdout and passes method, headers, body, and limits", async () => {
    const origSpawn = Bun.spawn;
    const calls: unknown[][] = [];
    try {
      (Bun as any).spawn = (args: string[]) => {
        calls.push(args);
        return {
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
              controller.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };

      const res = await curlFetch("http://example.invalid/api", {
        method: "POST",
        body: JSON.stringify({ hello: "curl" }),
        timeout: 2500,
        maxBytes: 2048,
      });

      expect(res).toEqual({ ok: true, status: 200, data: { ok: true } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("--max-time");
      expect(calls[0]).toContain("3");
      expect(calls[0]).toContain("--max-filesize");
      expect(calls[0]).toContain("2048");
      expect(calls[0]).toContain("-X");
      expect(calls[0]).toContain("POST");
      expect(calls[0]).toContain("-d");
      expect(calls[0]).toContain(JSON.stringify({ hello: "curl" }));
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  test("kills curl when streamed stdout exceeds maxBytes", async () => {
    const origSpawn = Bun.spawn;
    let killed = false;
    try {
      (Bun as any).spawn = () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.enqueue(new Uint8Array(8));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        kill: () => { killed = true; },
      });

      const res = await curlFetch("http://example.invalid/huge", { maxBytes: 10, timeout: 1000 });

      expect(res.ok).toBe(false);
      expect(res.data?.error).toMatch(/body exceeded 10 bytes/);
      expect(killed).toBe(true);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });
});

describe("curlFetch federation auth", () => {
  liveTest("protected endpoint with wrong token gets rejected", async () => {
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
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
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
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

afterAll(() => {
  if (origCurlFetchTransport === undefined) {
    delete process.env.MAW_CURL_FETCH_TRANSPORT;
  } else {
    process.env.MAW_CURL_FETCH_TRANSPORT = origCurlFetchTransport;
  }
});
