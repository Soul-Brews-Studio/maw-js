/**
 * process-guards.ts — the last-resort process guards.
 *
 * Imported from its own module, not from core/server: importing core/server runs
 * the plugin lifecycle and attempts a real Bun.serve, which in the default suite
 * fought the live maw for port 3456 and failed a neighbouring pty test.
 *
 * Context: on 2026-08-10 a single ws frame with `"target": null` produced an
 * unhandled rejection and Bun took `maw serve` down with it, blinding Colony for
 * the whole fleet. That specific hole is closed at its source in pty.ts; these
 * guards exist because the *shape* of it — an async handler invoked without
 * await — is one a future edit can reintroduce anywhere on any route, and the
 * cost is never proportional to the mistake.
 *
 * These tests install real process listeners, so every one of them removes what
 * it added: a leaked "uncaughtException" listener would silently swallow genuine
 * failures in whatever test file runs next.
 */
import { describe, expect, test } from "bun:test";
import { installProcessGuards, resetProcessGuardsForTest } from "../src/core/process-guards";

function withGuards<T>(body: (logs: string[]) => T): T {
  const before = {
    rejection: process.listeners("unhandledRejection").slice(),
    exception: process.listeners("uncaughtException").slice(),
  };
  const logs: string[] = [];
  try {
    return body(logs);
  } finally {
    // Remove only what this test added, and restore the install flag.
    for (const l of process.listeners("unhandledRejection")) {
      if (!before.rejection.includes(l)) process.off("unhandledRejection", l as never);
    }
    for (const l of process.listeners("uncaughtException")) {
      if (!before.exception.includes(l)) process.off("uncaughtException", l as never);
    }
    resetProcessGuardsForTest();
  }
}

describe("installProcessGuards", () => {
  test("registers one listener per fatal signal and is idempotent", () => {
    withGuards((logs) => {
      const rejectionsBefore = process.listenerCount("unhandledRejection");
      const exceptionsBefore = process.listenerCount("uncaughtException");

      expect(installProcessGuards({ error: (m) => logs.push(m) })).toBe(true);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBefore + 1);
      expect(process.listenerCount("uncaughtException")).toBe(exceptionsBefore + 1);

      // startBunGatewayServer can run more than once in a process (tests, TLS
      // restarts). Re-registering would multiply every future log line by the
      // number of starts.
      expect(installProcessGuards({ error: (m) => logs.push(m) })).toBe(false);
      expect(process.listenerCount("unhandledRejection")).toBe(rejectionsBefore + 1);
      expect(process.listenerCount("uncaughtException")).toBe(exceptionsBefore + 1);
    });
  });

  test("logs a rejection and keeps going instead of ending the process", () => {
    withGuards((logs) => {
      installProcessGuards({ error: (m) => logs.push(m) });
      const handler = process.listeners("unhandledRejection").at(-1) as (r: unknown) => void;

      // The real thing: what `target.replace` on null produced.
      expect(() => handler(new TypeError("null is not an object (evaluating 'target.replace')"))).not.toThrow();

      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("unhandled rejection");
      expect(logs[0]).toContain("server kept running");
      expect(logs[0]).toContain("target.replace");
    });
  });

  test("logs a non-Error rejection reason without throwing on it", () => {
    withGuards((logs) => {
      installProcessGuards({ error: (m) => logs.push(m) });
      const handler = process.listeners("unhandledRejection").at(-1) as (r: unknown) => void;

      // A rejection reason is whatever was thrown — frequently not an Error.
      expect(() => handler("plain string reason")).not.toThrow();
      expect(() => handler(undefined)).not.toThrow();

      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("plain string reason");
    });
  });

  test("logs an uncaught exception and keeps going", () => {
    withGuards((logs) => {
      installProcessGuards({ error: (m) => logs.push(m) });
      const handler = process.listeners("uncaughtException").at(-1) as (e: Error) => void;

      expect(() => handler(new Error("boom"))).not.toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("uncaught exception");
      expect(logs[0]).toContain("server kept running");
      expect(logs[0]).toContain("boom");
    });
  });
});
