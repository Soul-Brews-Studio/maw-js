import { describe, expect, it } from "bun:test";
import { probeServer } from "./probe";

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (url: string, init: RequestInit) => impl(url, init)) as unknown as typeof fetch;
}

describe("kobo-458 probeServer — ok / slow / dead / probe-error must never collapse into each other", () => {
  it("fast 200 response → ok", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
    });
    expect(result.status).toBe("ok");
  });

  it("200 response past the slow-threshold → slow, not ok, not dead", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      slowThresholdMs: 0, // any measurable delay counts as slow for this test
      fetchImpl: fakeFetch(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return new Response("{}", { status: 200 });
      }),
    });
    expect(result.status).toBe("slow");
  });

  it("connection-refused (real Bun error shape: Error with .code ConnectionRefused) → dead", async () => {
    // Verified directly on Bun 1.3.14 before writing this fixture: a real
    // fetch to an unreachable local port throws exactly this shape — an
    // Error whose .code is "ConnectionRefused", NOT a plain message string.
    // A fixture that just throws `new Error("ECONNREFUSED")` as text would
    // never carry the property the real discriminator checks (F1) and would
    // pass whether or not the discrimination logic works at all.
    const err = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => { throw err; }),
    });
    expect(result.status).toBe("dead");
    if (result.status === "dead") expect(result.cause).toBe("refused"); // %5 review: refused vs timeout must not be blind in the result
  });

  it("our own timeout firing (real Bun error shape: DOMException named TimeoutError) → dead", async () => {
    // Verified directly on Bun 1.3.14: AbortSignal.timeout() firing produces
    // a DOMException named "TimeoutError", not a generic Error.
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => { throw new DOMException("The operation timed out.", "TimeoutError"); }),
    });
    expect(result.status).toBe("dead");
    if (result.status === "dead") expect(result.cause).toBe("timeout");
  });

  it("an unrecognized throw (a bug in a caller-supplied fetchImpl, not a real network failure) → probe-error, NOT dead — F1", async () => {
    // This is the mutation-worthy case: a bare catch-all would fold this into
    // "dead" and restart a server the probe never actually reached. A plain
    // TypeError from broken wiring carries neither the ConnectionRefused code
    // nor the TimeoutError name, so it must be recognized as the WATCHER
    // failing, not the server.
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => { throw new TypeError("Cannot read properties of undefined (reading 'foo')"); }),
    });
    expect(result.status).toBe("probe-error");
  });

  it("non-2xx response → dead, not ok — an answer that isn't usable is the same bucket as no answer", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })),
    });
    expect(result.status).toBe("dead");
    if (result.status === "dead") expect(result.cause).toBe("http-error");
  });

  it("malformed URL → probe-error, distinct from dead — this is the WATCHER misconfigured, not the server unreachable", async () => {
    const result = await probeServer("not a url at all", { fetchImpl: fakeFetch(() => new Response("{}")) });
    expect(result.status).toBe("probe-error");
  });

  it("non-function fetchImpl → probe-error", async () => {
    const result = await probeServer("http://localhost:3456/api/probe", {
      fetchImpl: "not a function" as unknown as typeof fetch,
    });
    expect(result.status).toBe("probe-error");
  });
});
