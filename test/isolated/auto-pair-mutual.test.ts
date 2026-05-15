import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";

const TEST_HOME = mkdtempSync(join(tmpdir(), "maw-auto-pair-1494-"));
const TOKEN = "0123456789abcdef-auto-pair-token";
const ALICE_PUBKEY = "a".repeat(64);

process.env.MAW_HOME = TEST_HOME;
process.env.PEERS_FILE = join(TEST_HOME, "peers.json");
process.env.MAW_TEST_MODE = "1";
delete process.env.MAW_PEER_KEY;

mkdirSync(join(TEST_HOME, "config", "fleet"), { recursive: true });
writeFileSync(
  join(TEST_HOME, "config", "maw.config.json"),
  JSON.stringify({
    node: "bob",
    oracle: "mawjs",
    port: 3456,
    federationToken: TOKEN,
  }, null, 2),
);

const { pairApi, recordHelloZid } = await import("../../src/api/pair");
const { verifyAutoPairProof } = await import("../../src/transports/scout-pair-proof");
const { initiatePair } = await import("../../src/transports/scout-pair");

const app = new Elysia().use(pairApi);

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.MAW_HOME;
  delete process.env.PEERS_FILE;
});

describe("Scout auto-pair mutual pubkey/proof (#1494)", () => {
  test("responder pins request pubkey and signs its identity response", async () => {
    recordHelloZid("zid-mutual");

    const res = await app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node: "alice",
        oracle: "mawjs",
        url: "http://127.0.0.1:1",
        zid: "zid-mutual",
        pubkey: ALICE_PUBKEY,
        capabilities: ["pair"],
      }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      node: string;
      oracle: string;
      url: string;
      pubkey: string;
      proof: string;
      oneWay: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.node).toBe("bob");
    expect(body.oracle).toBe("mawjs");
    expect(body.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAutoPairProof({
      node: body.node,
      oracle: body.oracle,
      url: body.url,
      pubkey: body.pubkey,
    }, TOKEN, body.proof)).toBe(true);

    const peers = JSON.parse(readFileSync(process.env.PEERS_FILE!, "utf-8"));
    expect(peers.peers.alice.pubkey).toBe(ALICE_PUBKEY);
    expect(peers.peers.alice.identity).toEqual({ oracle: "mawjs", node: "alice" });
    expect(peers.peers.alice.oneWay).toBe(true);
    expect(typeof peers.peers.alice.lastSymmetricCheck).toBe("string");
  });

  test("initiator retries transient POST failure and writes responder pubkey", async () => {
    const calls: Array<RequestInfo | URL> = [];
    const addCalls: unknown[] = [];
    const responderPubkey = "b".repeat(64);
    const proof = verifyAutoPairProof;
    const { signAutoPairProof } = await import("../../src/transports/scout-pair-proof");
    const response = {
      ok: true,
      node: "bob",
      oracle: "mawjs",
      url: "http://bob:3456",
      pubkey: responderPubkey,
      proof: signAutoPairProof({
        node: "bob",
        oracle: "mawjs",
        url: "http://bob:3456",
        pubkey: responderPubkey,
      }, TOKEN),
      oneWay: false,
    };

    const result = await initiatePair(
      {
        node: "bob",
        zid: "zid-retry",
        host: "bob",
        oracle: "mawjs",
        locators: ["http://bob:3456"],
        capabilities: ["pair"],
        oracles: ["mawjs"],
        lastSeen: Date.now(),
        paired: false,
      },
      "alice",
      "mawjs",
      3456,
      {
        fetchFn: (async (input: RequestInfo | URL) => {
          calls.push(input);
          if (calls.length === 1) throw new Error("temporary timeout");
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
        sleep: async () => {},
        cmdAddFn: (async (opts) => {
          addCalls.push(opts);
          return {
            alias: opts.alias,
            overwrote: false,
            peer: {
              url: opts.url,
              node: opts.node ?? null,
              addedAt: new Date().toISOString(),
              lastSeen: new Date().toISOString(),
            },
          };
        }) as typeof import("../../src/lib/peers/impl").cmdAdd,
        getPeerKeyFn: () => ALICE_PUBKEY,
        loadConfigFn: () => ({ federationToken: TOKEN } as any),
      },
    );

    expect(proof({
      node: response.node,
      oracle: response.oracle,
      url: response.url,
      pubkey: response.pubkey,
    }, TOKEN, response.proof)).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(2);
    expect(addCalls[0]).toMatchObject({
      alias: "bob",
      url: "http://bob:3456",
      node: "bob",
      pubkey: responderPubkey,
      identity: { oracle: "mawjs", node: "bob" },
      markSymmetricCheck: true,
      oneWay: false,
    });
  });

  test("initiator rejects bad proof and does not write peers.json", async () => {
    let addCalled = false;
    const result = await initiatePair(
      {
        node: "mallory",
        zid: "zid-proof",
        host: "mallory",
        oracle: "mawjs",
        locators: ["http://mallory:3456"],
        capabilities: ["pair"],
        oracles: ["mawjs"],
        lastSeen: Date.now(),
        paired: false,
      },
      "alice",
      "mawjs",
      3456,
      {
        fetchFn: (async () => new Response(JSON.stringify({
          ok: true,
          node: "mallory",
          oracle: "mawjs",
          url: "http://mallory:3456",
          pubkey: "c".repeat(64),
          proof: "0".repeat(64),
        }), { status: 200 })) as typeof fetch,
        sleep: async () => {},
        cmdAddFn: (async () => {
          addCalled = true;
          throw new Error("should not write");
        }) as typeof import("../../src/lib/peers/impl").cmdAdd,
        getPeerKeyFn: () => ALICE_PUBKEY,
        loadConfigFn: () => ({ federationToken: TOKEN } as any),
      },
    );

    expect(result).toEqual({ ok: false, error: "bad_proof" });
    expect(addCalled).toBe(false);
  });
});
