import { describe, test, expect, mock } from "bun:test";

import { mockConfigModule } from "../helpers/mock-config";
mock.module("../../src/config", () => mockConfigModule(() => ({
  node: "test",
  port: 3456,
  peers: ["http://peer.example:3456"],
})));

// Per-URL-substring response stub — each test sets `responses` for sessions/identity.
let responses: Array<{ match: string; res: { ok: boolean; status: number; data: unknown } }> = [];
mock.module("../../src/core/transport/curl-fetch", () => ({
  curlFetch: async (url: string) => {
    for (const { match, res } of responses) {
      if (url.includes(match)) return res;
    }
    return { ok: false, status: 0, data: null };
  },
}));

const { getFederationStatus, resetPeerCaches } = await import("../../src/core/transport/peers");
import { beforeEach } from "bun:test";

describe("checkPeerReachable — identity failure visibility (#385 site 3)", () => {
  beforeEach(() => { resetPeerCaches(); });
  test("warns when peer is reachable (sessions ok) but /api/identity fails", async () => {
    responses = [
      { match: "/api/sessions", res: { ok: true, status: 200, data: [] } },
      { match: "/api/identity", res: { ok: false, status: 404, data: null } },
    ];

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const status = await getFederationStatus();
      // Return shape preserved: reachable=true, node=undefined (the confusing case).
      expect(status.peers[0]?.reachable).toBe(true);
      expect(status.peers[0]?.node).toBeUndefined();
      // User must be able to grep: peer URL + status code + identity context.
      const joined = warns.join("\n");
      expect(joined).toContain("identity");
      expect(joined).toContain("404");
      expect(joined).toContain("http://peer.example:3456");
    } finally {
      console.warn = origWarn;
    }
  });

  test("silent when peer is fully unreachable (sessions fails) — no double-warn", async () => {
    responses = [
      { match: "/api/sessions", res: { ok: false, status: 0, data: null } },
      { match: "/api/identity", res: { ok: false, status: 0, data: null } },
    ];

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      const status = await getFederationStatus();
      expect(status.peers[0]?.reachable).toBe(false);
      // No noisy identity warn for a peer we already know is down.
      expect(warns.join("\n")).not.toContain("identity");
    } finally {
      console.warn = origWarn;
    }
  });
});
