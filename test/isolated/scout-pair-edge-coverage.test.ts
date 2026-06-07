/** @maw-test-isolate */
import { describe, expect, test } from "bun:test";
import type { DiscoveredPeer } from "../../src/transports/scout-state";
import { initiatePair } from "../../src/transports/scout-pair";

function peer(patch: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    node: "bob",
    zid: "zid-edge",
    host: "bob",
    oracle: "mawjs",
    locators: ["http://bob:3456"],
    capabilities: ["pair"],
    oracles: ["mawjs"],
    lastSeen: 1,
    paired: false,
    ...patch,
  };
}

const baseDeps = {
  sleep: async () => {},
  getPeerKeyFn: () => "a".repeat(64),
  loadConfigFn: () => ({} as any),
};

describe("scout-pair edge coverage", () => {
  test("rejects peers without locators before network work", async () => {
    const result = await initiatePair(peer({ locators: [] }), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => {
        throw new Error("should not fetch");
      }) as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "no_locator" });
  });

  test("returns 4xx responses immediately with response text", async () => {
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => new Response("not paired", { status: 409 })) as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "http_409: not paired" });
  });

  test("retries server failures and reports rejected json responses", async () => {
    const statuses: number[] = [];
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => {
        statuses.push(500);
        if (statuses.length === 1) return new Response("oops", { status: 500 });
        return Response.json({ ok: false });
      }) as typeof fetch,
    });

    expect(statuses).toHaveLength(2);
    expect(result).toEqual({ ok: false, error: "rejected" });
  });

  test("uses the default retry sleep when no sleep dependency is injected", async () => {
    let attempts = 0;
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      getPeerKeyFn: () => "a".repeat(64),
      loadConfigFn: () => ({} as any),
      fetchFn: (async () => {
        attempts += 1;
        if (attempts === 1) return new Response("temporary", { status: 500 });
        return Response.json({ ok: true });
      }) as typeof fetch,
      cmdAddFn: (async () => ({
        alias: "bob",
        overwrote: false,
        peer: { url: "http://bob:3456", node: "bob", addedAt: "now", lastSeen: "now" },
      })) as typeof import("../../src/lib/peers/impl").cmdAdd,
    });

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  test("falls back to an empty 4xx response body when text reading fails", async () => {
    const response = new Response("not readable", { status: 403 });
    response.text = async () => { throw new Error("body gone"); };

    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => response) as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "http_403: " });
  });

  test("rejects incomplete proof payloads before writing peer state", async () => {
    let wrote = false;
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      loadConfigFn: () => ({ federationToken: "token" } as any),
      fetchFn: (async () => Response.json({ ok: true, proof: "abc" })) as typeof fetch,
      cmdAddFn: (async () => {
        wrote = true;
        throw new Error("should not write");
      }) as typeof import("../../src/lib/peers/impl").cmdAdd,
    });

    expect(result).toEqual({ ok: false, error: "bad_proof_payload" });
    expect(wrote).toBe(false);
  });

  test("surfaces pubkey mismatches from cmdAdd", async () => {
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => Response.json({ ok: true, pubkey: "b".repeat(64), node: "bob", oneWay: true })) as typeof fetch,
      cmdAddFn: (async () => ({
        alias: "bob",
        overwrote: false,
        pubkeyMismatch: { message: "pubkey mismatch for bob" },
        peer: { url: "http://bob:3456", node: "bob", addedAt: "now", lastSeen: "now" },
      })) as typeof import("../../src/lib/peers/impl").cmdAdd,
    });

    expect(result).toEqual({ ok: false, error: "pubkey mismatch for bob" });
  });

  test("keeps the final non-Error fetch failure after all retries", async () => {
    let attempts = 0;
    const result = await initiatePair(peer(), "alice", "mawjs", 3456, {
      ...baseDeps,
      fetchFn: (async () => {
        attempts += 1;
        throw "socket closed";
      }) as typeof fetch,
    });

    expect(attempts).toBe(3);
    expect(result).toEqual({ ok: false, error: "socket closed" });
  });
});
