import { describe, test, expect, mock } from "bun:test";

// Mock paths/config so peers.ts can import ../../config safely in isolation.
mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp",
}));

import { mockConfigModule } from "../helpers/mock-config";
mock.module("../../src/config", () => mockConfigModule(() => ({
  federationToken: "test-token",
  node: "test",
  peers: [],
})));

// Stub curlFetch — each test overrides `nextResponse` / `nextThrow`.
let nextResponse: { ok: boolean; status: number; data: unknown } = { ok: true, status: 200, data: null };
let nextThrow: Error | null = null;
mock.module("../../src/core/transport/curl-fetch", () => ({
  curlFetch: async () => {
    if (nextThrow) throw nextThrow;
    return nextResponse;
  },
}));

const { sendKeysToPeer } = await import("../../src/core/transport/peers");

describe("sendKeysToPeer — error visibility (#385 site 2)", () => {
  test("surfaces 401 status in a console.warn before returning false", async () => {
    nextThrow = null;
    nextResponse = { ok: false, status: 401, data: { error: "invalid hmac" } };

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const ok = await sendKeysToPeer("http://peer.example:3456", "oracle:main", "hey");
      expect(ok).toBe(false);
      // User must be able to diagnose: status code, peer, and target must be greppable.
      const joined = warns.join("\n");
      expect(joined).toContain("401");
      expect(joined).toContain("http://peer.example:3456");
      expect(joined).toContain("oracle:main");
    } finally {
      console.warn = origWarn;
    }
  });

  test("surfaces thrown errors (network/timeout) in a console.warn", async () => {
    nextResponse = { ok: true, status: 200, data: null };
    nextThrow = new Error("connect ETIMEDOUT");

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const ok = await sendKeysToPeer("http://peer.example:3456", "oracle:main", "hey");
      expect(ok).toBe(false);
      expect(warns.join("\n")).toContain("ETIMEDOUT");
    } finally {
      console.warn = origWarn;
      nextThrow = null;
    }
  });

  test("silent on success — no warn when res.ok is true", async () => {
    nextThrow = null;
    nextResponse = { ok: true, status: 200, data: { ok: true } };

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const ok = await sendKeysToPeer("http://peer.example:3456", "oracle:main", "hey");
      expect(ok).toBe(true);
      expect(warns.length).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });
});
