/**
 * peer-tofu-cache.test.ts — #804 Step 2.
 *
 * TOFU (Trust On First Use) caching of federation peer pubkeys. The cache
 * shape is `peers.json` extended with `pubkey` + `pubkeyFirstSeen` fields.
 *
 * Test plan covers the O6 truth-table cells from
 * docs/federation/0001-peer-identity.md that are reachable from a single
 * `/api/identity` exchange:
 *
 *   1. First contact, peer advertises pubkey       → cache it
 *   2. Subsequent contact, same pubkey             → no-op write, validates
 *   3. Subsequent contact, different pubkey        → refuse (mismatch)
 *   4. `peers forget`                              → clears the pin
 *   5. First contact, legacy peer (no pubkey)      → cache without pubkey
 *   6. Pinned peer, response missing pubkey        → warn but accept
 *
 * Isolated because the modules under test write to PEERS_FILE; we sandbox
 * that path per-test and stub `globalThis.fetch` so probePeer's /info +
 * /api/identity round-trips never hit the network.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let realFetch: typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-tofu-804-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

/** Stub fetch that returns canned /info + /api/identity bodies. */
function stubFetch(opts: {
  info: object;
  identity?: object;
  identityStatus?: number;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify(opts.info), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/identity")) {
      if (opts.identity === undefined) {
        // Legacy peer: no /api/identity at all.
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(opts.identity), {
        status: opts.identityStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected url " + url, { status: 500 });
  }) as unknown as typeof fetch;
}

const VALID_INFO = {
  node: "white",
  version: "26.4.29-alpha.4",
  ts: new Date().toISOString(),
  maw: { schema: "1", plugins: { manifestEndpoint: "/api/plugins" }, capabilities: [] },
};

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

describe("TOFU peer pubkey cache (#804 Step 2)", () => {
  test("first contact: pubkey is written to cache + pubkeyFirstSeen is ISO", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd } = await import("../../src/commands/plugins/peers/impl");
    const res = await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });
    expect(res.peer.pubkey).toBe(PUBKEY_A);
    expect(res.peer.pubkeyFirstSeen).toBeDefined();
    expect(() => new Date(res.peer.pubkeyFirstSeen!).toISOString()).not.toThrow();

    // Verify on disk too.
    const onDisk = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(onDisk.peers.white.pubkey).toBe(PUBKEY_A);
    expect(typeof onDisk.peers.white.pubkeyFirstSeen).toBe("string");
  });

  test("subsequent contact with same pubkey: validates ok, pubkey unchanged", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd, cmdProbe } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });

    // Second probe — same pubkey; must succeed, no mismatch surfaced.
    const r = await cmdProbe("white");
    expect(r.ok).toBe(true);
    expect(r.pubkeyMismatch).toBeUndefined();

    const onDisk = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(onDisk.peers.white.pubkey).toBe(PUBKEY_A);
  });

  test("subsequent contact with different pubkey: returns mismatch + does not overwrite", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd, cmdProbe } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });

    // Now the peer's response advertises a different pubkey.
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_B } });

    const r = await cmdProbe("white");
    expect(r.pubkeyMismatch).toBeDefined();
    expect(r.pubkeyMismatch?.cached).toBe(PUBKEY_A);
    expect(r.pubkeyMismatch?.observed).toBe(PUBKEY_B);
    expect(r.pubkeyMismatch?.message).toContain("maw peers forget white");

    // Disk pubkey must NOT have changed — refusal must be a no-write.
    const onDisk = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(onDisk.peers.white.pubkey).toBe(PUBKEY_A);
  });

  test("forget command clears the cached pubkey + allows re-TOFU on next contact", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd, cmdForget, cmdProbe } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });

    const outcome = await cmdForget("white");
    expect(outcome).toBe("cleared");

    // Disk: pubkey + pubkeyFirstSeen are gone, alias still present.
    const after = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(after.peers.white).toBeDefined();
    expect(after.peers.white.pubkey).toBeUndefined();
    expect(after.peers.white.pubkeyFirstSeen).toBeUndefined();

    // Now the peer rotates to pubkey B — re-TOFU must succeed (no mismatch
    // because the cache was cleared).
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_B } });
    const r = await cmdProbe("white");
    expect(r.ok).toBe(true);
    expect(r.pubkeyMismatch).toBeUndefined();
    const reTofu = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(reTofu.peers.white.pubkey).toBe(PUBKEY_B);
  });

  test("legacy peer (no /api/identity): cache entry has no pubkey, add succeeds", async () => {
    // identity: undefined means our stub returns 404 for /api/identity.
    stubFetch({ info: VALID_INFO });
    const { cmdAdd } = await import("../../src/commands/plugins/peers/impl");
    const res = await cmdAdd({ alias: "old", url: "http://127.0.0.1:13456" });
    expect(res.peer.pubkey).toBeUndefined();
    expect(res.peer.pubkeyFirstSeen).toBeUndefined();
    expect(res.pubkeyMismatch).toBeUndefined();
  });

  test("legacy peer that previously had a pubkey: warn but accept (no mismatch, no rewrite)", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd, cmdProbe } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });

    // Peer rolls back to pre-Step-1 — no /api/identity endpoint at all.
    stubFetch({ info: VALID_INFO });
    const r = await cmdProbe("white");
    expect(r.ok).toBe(true); // /info handshake still passes
    expect(r.pubkeyMismatch).toBeUndefined();

    // Cached pubkey must remain pinned (Step 4 will hard-fail this; for now
    // we accept-with-warn during the alpha migration window).
    const onDisk = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(onDisk.peers.white.pubkey).toBe(PUBKEY_A);
  });

  test("evaluatePeerIdentity: pure decision function maps O6 cases", async () => {
    const { evaluatePeerIdentity } = await import("../../src/commands/plugins/peers/tofu");
    // No cache entry, peer advertises pubkey → bootstrap.
    expect(evaluatePeerIdentity("a", undefined, PUBKEY_A).kind).toBe("tofu-bootstrap");
    // No cache entry, legacy peer → legacy-first-contact.
    expect(evaluatePeerIdentity("a", undefined, undefined).kind).toBe("legacy-first-contact");
    // Cached, observed matches → match.
    const peer = {
      url: "x",
      node: "x",
      addedAt: "x",
      lastSeen: null,
      pubkey: PUBKEY_A,
    };
    expect(evaluatePeerIdentity("a", peer, PUBKEY_A).kind).toBe("match");
    // Cached, observed missing → legacy-after-pinned.
    expect(evaluatePeerIdentity("a", peer, undefined).kind).toBe("legacy-after-pinned");
    // Cached, observed different → mismatch.
    expect(evaluatePeerIdentity("a", peer, PUBKEY_B).kind).toBe("mismatch");
  });

  test("forget on unknown alias returns 'not-found'", async () => {
    const { cmdForget } = await import("../../src/commands/plugins/peers/impl");
    expect(await cmdForget("ghost")).toBe("not-found");
  });

  test("forget on legacy peer (no pubkey ever cached) returns 'no-pubkey'", async () => {
    stubFetch({ info: VALID_INFO });
    const { cmdAdd, cmdForget } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "old", url: "http://127.0.0.1:13456" });
    expect(await cmdForget("old")).toBe("no-pubkey");
  });

  test("dispatcher: maw peers forget <alias> — happy + missing alias", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { cmdAdd } = await import("../../src/commands/plugins/peers/impl");
    await cmdAdd({ alias: "white", url: "http://127.0.0.1:13456" });

    const { default: handler } = await import("../../src/commands/plugins/peers/index");
    const res = await handler({ source: "cli", args: ["forget", "white"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("forgot pubkey for white");

    const missing = await handler({ source: "cli", args: ["forget"] });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("usage: maw peers forget");
  });

  test("dispatcher: maw peers add — TOFU mismatch returns exitCode 7 (fail loud)", async () => {
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_A } });
    const { default: handler } = await import("../../src/commands/plugins/peers/index");
    await handler({ source: "cli", args: ["add", "white", "http://127.0.0.1:13456"] });

    // Same alias, peer pretends to have rotated key.
    stubFetch({ info: VALID_INFO, identity: { node: "white", pubkey: PUBKEY_B } });
    const second = await handler({
      source: "cli",
      args: ["add", "white", "http://127.0.0.1:13456"],
    });
    expect(second.ok).toBe(false);
    expect(second.exitCode).toBe(7);
    expect(second.error).toContain("peer pubkey changed for white");
  });
});
