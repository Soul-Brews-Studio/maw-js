import { describe, test, expect, mock } from "bun:test";

// Mock config so cmdCosts can build its base URL in isolation.
import { mockConfigModule } from "../helpers/mock-config";
mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "127.0.0.1",
  port: 3456,
})));

import { cmdCosts } from "../../src/commands/plugins/costs/impl";

describe("cmdCosts — separated error paths (#390.1)", () => {
  test("real network failure → 'cannot reach maw server' (UserError)", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      await expect(cmdCosts()).rejects.toThrow(/cannot reach maw server.*maw serve/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("HTTP 404 → surfaces status code, not 'unreachable'", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response("route missing", { status: 404, statusText: "Not Found" });
    try {
      const err = await cmdCosts().catch((e) => e);
      expect(String(err.message)).toContain("404");
      expect(String(err.message)).toContain("Not Found");
      expect(String(err.message)).not.toContain("cannot reach");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("2xx with malformed JSON → 'non-JSON response'", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response("<html>oops</html>", { status: 200, statusText: "OK" });
    try {
      const err = await cmdCosts().catch((e) => e);
      expect(String(err.message)).toContain("non-JSON response");
      expect(String(err.message)).toContain("<html>");
      expect(String(err.message)).not.toContain("cannot reach");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
