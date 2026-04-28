/**
 * elysia-auth-protected.test.ts — #798.
 *
 * Pinpoint test: verify that the PROTECTED set in elysia-auth.ts gates
 * /wake and /sleep. Prior to #798, these write endpoints were unauthenticated
 * for non-loopback clients with federationToken configured — anyone reachable
 * on :3456 could trigger wake (clone/spawn/start agent) or sleep (kill agent).
 *
 * Cousin file `federation-auth.test.ts` covers the Hono-based middleware in
 * `federation-auth.ts`; this file targets the Elysia-based variant in
 * `elysia-auth.ts` which is what `src/api/index.ts` actually `.use()`s.
 */
import { describe, test, expect } from "bun:test";
import { isProtected } from "../../src/lib/elysia-auth";

describe("elysia-auth — isProtected (#798)", () => {
  test("/wake POST is protected", () => {
    expect(isProtected("/wake", "POST")).toBe(true);
  });

  test("/sleep POST is protected", () => {
    expect(isProtected("/sleep", "POST")).toBe(true);
  });

  test("existing protected paths still gated", () => {
    expect(isProtected("/send", "POST")).toBe(true);
    expect(isProtected("/pane-keys", "POST")).toBe(true);
    expect(isProtected("/talk", "POST")).toBe(true);
  });

  test("/probe POST is protected (#804 Step 5 — same auth surface as /send)", () => {
    expect(isProtected("/probe", "POST")).toBe(true);
  });

  test("read endpoints remain public", () => {
    expect(isProtected("/sessions", "GET")).toBe(false);
    expect(isProtected("/capture", "GET")).toBe(false);
    expect(isProtected("/mirror", "GET")).toBe(false);
  });

  test("/feed: GET public, POST protected (PROTECTED_POST set)", () => {
    expect(isProtected("/feed", "GET")).toBe(false);
    expect(isProtected("/feed", "POST")).toBe(true);
  });
});
