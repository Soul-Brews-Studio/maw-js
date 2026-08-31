import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { rememberClientIp, resolveClientIp } from "../src/lib/elysia-auth";

// Loopback-bypass clone regression (maw-serve incident 2026-08-31).
//
// server.ts hands `req.clone()` to api.handle() for protected routes, but
// Bun's requestIP() is keyed by Request identity and returns null for a
// clone. Null is treated as non-loopback (fail-closed), so once a
// federationToken was configured every unsigned local call — health probe,
// engine-plugin registration, local CLI writes — got 401 missing_signature.
// The fix records the original request's address for the clone via
// rememberClientIp() before Elysia sees it.

describe("Bun requestIP on cloned Request (documents why the map exists)", () => {
  test("clone loses the address; original resolves loopback", async () => {
    let orig: string | undefined;
    let clone: string | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        orig = server.requestIP(req)?.address;
        clone = server.requestIP(req.clone())?.address;
        return new Response("ok");
      },
    });
    await fetch(`http://127.0.0.1:${server.port}/`);
    server.stop();
    expect(orig).toBe("127.0.0.1");
    // If Bun ever resolves clones by socket instead of identity this starts
    // failing — the WeakMap carry becomes redundant (though still harmless).
    expect(clone).toBeUndefined();
  });
});

describe("rememberClientIp / resolveClientIp", () => {
  test("a remembered clone resolves to the recorded address", () => {
    const req = new Request("http://localhost/api/probe", { method: "POST" });
    rememberClientIp(req, "127.0.0.1");
    expect(resolveClientIp(req)).toBe("127.0.0.1");
  });

  test("an undefined address records nothing", () => {
    const req = new Request("http://localhost/api/probe", { method: "POST" });
    rememberClientIp(req, undefined);
    expect(resolveClientIp(req)).toBeUndefined();
  });

  test("an unknown request falls through (no stale/global state)", () => {
    const a = new Request("http://localhost/api/probe", { method: "POST" });
    const b = new Request("http://localhost/api/probe", { method: "POST" });
    rememberClientIp(a, "10.0.0.9");
    expect(resolveClientIp(b)).toBeUndefined();
  });
});

describe("server.ts clone-site regression guard", () => {
  test("protected api.handle receives a clone that went through rememberClientIp", () => {
    const src = readFileSync(
      new URL("../src/core/server.ts", import.meta.url).pathname,
      "utf-8",
    );
    // The protected branch must not hand a bare req.clone() to api.handle —
    // that recreates the null-requestIP 401.
    expect(src).not.toContain("api.handle(req.clone())");
    expect(src).toContain("rememberClientIp(authReq, server.requestIP(req)?.address)");
    expect(src).toContain("api.handle(authReq)");
  });

  test("auth hooks resolve the client IP through the clone-aware helper", () => {
    const src = readFileSync(
      new URL("../src/lib/elysia-auth.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Every auth layer must use resolveClientIp; a raw requestIP(request)
    // in a hook silently loses the clone carry.
    const hookBody = src.slice(src.indexOf("captureBodyForAuth"));
    expect(hookBody).not.toContain("_bunServer?.requestIP?.(request)?.address;");
    expect((src.match(/resolveClientIp\(request\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
