/**
 * loopback-requestip.test.ts — regression guard for the federation-auth loopback
 * bug: server.ts handed `req.clone()` to the auth handler, but Bun's
 * server.requestIP() only resolves the socket for the ORIGINAL Request object.
 * The clone returned undefined, so local loopback callers (status-reporter hook,
 * maw's own emitFeed, any local CLI) were misread as non-loopback and rejected
 * with 401. The fix passes the original request to the auth handler (clone goes
 * to the plugin fall-through instead).
 *
 * This proves, against a real Bun socket + Elysia handler, that:
 *   - a CLONED request → requestIP() is null  (the bug)
 *   - the ORIGINAL request → requestIP() is a loopback address isLoopback trusts
 */
import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { isLoopback } from "../../src/lib/federation-auth";

test("Elysia preserves request identity so requestIP resolves loopback for the original (not a clone)", async () => {
  let server: any;
  const app = new Elysia().post("/probe", ({ request }) => {
    const ip = server?.requestIP?.(request)?.address ?? null;
    return new Response(JSON.stringify({ ip }), { headers: { "content-type": "application/json" } });
  });

  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).searchParams.get("mode") === "clone"
        ? app.handle(req.clone()) // the bug
        : app.handle(req), //         the fix
  });

  const base = `http://localhost:${server.port}/probe`;
  const ipFor = async (mode: string) =>
    (await (await fetch(`${base}?mode=${mode}`, { method: "POST", body: "{}" })).json()).ip;

  const cloneIp = await ipFor("clone");
  const originalIp = await ipFor("original");
  server.stop(true);

  // the bug: clone loses the socket → undefined → isLoopback false → 401
  expect(cloneIp).toBeNull();
  expect(isLoopback(cloneIp ?? undefined)).toBe(false);

  // the fix: original resolves a real loopback address the auth layer trusts
  expect(originalIp).not.toBeNull();
  expect(isLoopback(originalIp)).toBe(true);
});
