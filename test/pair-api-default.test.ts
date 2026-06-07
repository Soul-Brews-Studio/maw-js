import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  _resetResults,
  createPairApi,
  recordHelloZid,
  type PairApiDeps,
} from "../src/api/pair";
import {
  isValidShape,
  normalize,
  pretty,
  type PairEntry,
  type LookupResult,
} from "../src/lib/pair-codes";

interface Harness {
  app: Elysia;
  entries: Map<string, PairEntry>;
  addCalls: any[];
  setNow(value: number): void;
  setCmdAdd(fn: PairApiDeps["cmdAdd"]): void;
  setConfig(config: any): void;
}

function json(res: Response): Promise<any> {
  return res.json();
}

function makeHarness(): Harness {
  const entries = new Map<string, PairEntry>();
  const addCalls: any[] = [];
  let now = 1_000_000;
  let config: any = { node: "node-a", oracle: "oracle-a", port: 4567, federationToken: "token-a" };
  let cmdAdd: PairApiDeps["cmdAdd"] = (async (opts) => {
    addCalls.push(opts);
    return {
      alias: opts.alias,
      overwrote: false,
      peer: {
        url: opts.url,
        node: opts.node ?? null,
        oneWay: true,
        addedAt: new Date(now).toISOString(),
      },
    } as any;
  }) as PairApiDeps["cmdAdd"];

  const lookup = ((code: string): LookupResult => {
    const entry = entries.get(normalize(code));
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.consumed) return { ok: false, reason: "consumed" };
    if (now > entry.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, entry };
  }) as PairApiDeps["lookup"];

  const deps: PairApiDeps = {
    loadConfig: (() => config) as PairApiDeps["loadConfig"],
    randomBytes: ((size: number) => Buffer.alloc(size, 0xab)) as PairApiDeps["randomBytes"],
    register: ((code: string, ttlMs: number) => {
      const entry = { code: normalize(code), expiresAt: now + ttlMs, consumed: false, createdAt: now };
      entries.set(entry.code, entry);
      return entry;
    }) as PairApiDeps["register"],
    lookup,
    consume: ((code: string) => {
      const result = lookup(code);
      if (!result.ok) return result;
      result.entry.consumed = true;
      return result;
    }) as PairApiDeps["consume"],
    isValidShape,
    normalize,
    pretty,
    generateCode: () => "ABC234",
    cmdAdd: ((opts) => cmdAdd(opts)) as PairApiDeps["cmdAdd"],
    getPeerKey: () => "p".repeat(64),
    signAutoPairProof: ((identity, token) => `proof:${identity.node}:${identity.pubkey}:${token}`) as PairApiDeps["signAutoPairProof"],
    now: () => now,
  };

  return {
    app: new Elysia().use(createPairApi(deps)),
    entries,
    addCalls,
    setNow(value: number) { now = value; },
    setCmdAdd(fn: PairApiDeps["cmdAdd"]) { cmdAdd = fn; },
    setConfig(next: any) { config = next; },
  };
}

beforeEach(() => {
  _resetResults();
});

describe("pair API default-suite coverage", () => {
  test("default router factory is constructible", () => {
    expect(createPairApi()).toBeInstanceOf(Elysia);
  });

  test("generates pretty pair codes with default, expires, and ttlMs TTL inputs", async () => {
    const h = makeHarness();

    let res = await h.app.handle(new Request("http://local/pair/generate", { method: "POST" }));
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({
      ok: true,
      code: "ABC-234",
      expiresAt: 1_120_000,
      ttlMs: 120_000,
      node: "node-a",
      port: 4567,
    });

    res = await h.app.handle(new Request("http://local/pair/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires: 5 }),
    }));
    expect(await json(res)).toMatchObject({ ttlMs: 5_000, expiresAt: 1_005_000 });

    res = await h.app.handle(new Request("http://local/pair/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlMs: 42 }),
    }));
    expect(await json(res)).toMatchObject({ ttlMs: 42, expiresAt: 1_000_042 });
  });

  test("probes invalid, missing, expired, and live pair codes", async () => {
    const h = makeHarness();

    let res = await h.app.handle(new Request("http://local/pair/bad/probe"));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "invalid_shape" });

    res = await h.app.handle(new Request("http://local/pair/ABC234/probe"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ ok: false, error: "not_found" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 1, consumed: false });
    res = await h.app.handle(new Request("http://local/pair/ABC234/probe"));
    expect(res.status).toBe(410);
    expect(await json(res)).toEqual({ ok: false, error: "expired" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 2_000_000, consumed: false });
    res = await h.app.handle(new Request("http://local/pair/ABC234/probe"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, node: "node-a" });
  });

  test("accepts pair posts, records consumed status, and ignores cmdAdd failures", async () => {
    const h = makeHarness();

    let res = await h.app.handle(new Request("http://local/pair/bad", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "invalid_shape" });

    res = await h.app.handle(new Request("http://local/pair/ABC234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "bad_request" });

    res = await h.app.handle(new Request("http://local/pair/ABC234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote" }),
    }));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ ok: false, error: "not_found" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 1, consumed: false });
    res = await h.app.handle(new Request("http://local/pair/ABC234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote" }),
    }));
    expect(res.status).toBe(410);
    expect(await json(res)).toEqual({ ok: false, error: "expired" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 2_000_000, consumed: false });
    h.setCmdAdd((async () => { throw new Error("peer write failed"); }) as PairApiDeps["cmdAdd"]);
    res = await h.app.handle(new Request("http://local/pair/ABC234", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote" }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      node: "node-a",
      url: "http://localhost:4567",
      federationToken: "ab".repeat(32),
    });

    res = await h.app.handle(new Request("http://local/pair/ABC-234/status"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, consumed: true, remoteNode: "remote", remoteUrl: "http://remote" });
  });

  test("reports pending, missing, and expired status for unconsumed codes", async () => {
    const h = makeHarness();

    let res = await h.app.handle(new Request("http://local/pair/ABC234/status"));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ ok: false, error: "not_found" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 1, consumed: false });
    res = await h.app.handle(new Request("http://local/pair/ABC234/status"));
    expect(res.status).toBe(410);
    expect(await json(res)).toEqual({ ok: false, error: "expired" });

    h.entries.set("ABC234", { code: "ABC234", createdAt: 0, expiresAt: 2_000_000, consumed: false });
    res = await h.app.handle(new Request("http://local/pair/ABC234/status"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, consumed: false });
  });

  test("auto-pair validates hello freshness, reports add errors, and returns signed identity", async () => {
    const h = makeHarness();

    let res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "missing_fields" });

    res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote", zid: "missing" }),
    }));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ ok: false, error: "no_recent_hello" });

    recordHelloZid("old", 0);
    recordHelloZid("fresh", 70_001);
    h.setNow(70_001);
    res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote", zid: "old" }),
    }));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ ok: false, error: "no_recent_hello" });

    recordHelloZid("mismatch", 70_001);
    h.setCmdAdd((async () => ({ pubkeyMismatch: { message: "key mismatch" }, peer: {} })) as PairApiDeps["cmdAdd"]);
    res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote", zid: "mismatch" }),
    }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ ok: false, error: "key mismatch" });

    recordHelloZid("throws", 70_001);
    h.setCmdAdd((async () => { throw "bad peer"; }) as PairApiDeps["cmdAdd"]);
    res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "remote", url: "http://remote", zid: "throws" }),
    }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ ok: false, error: "bad peer" });

    recordHelloZid("success", 70_001);
    h.setConfig({ node: "node-a", oracle: "oracle-a", port: 4567, federationToken: "token-a" });
    h.setCmdAdd((async (opts) => {
      h.addCalls.push(opts);
      return { peer: { oneWay: false } } as any;
    }) as PairApiDeps["cmdAdd"]);
    res = await h.app.handle(new Request("http://local/pair/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node: "remote",
        oracle: "remote-oracle",
        url: "http://remote",
        zid: "success",
        pubkey: "r".repeat(64),
      }),
    }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      node: "node-a",
      oracle: "oracle-a",
      url: "http://localhost:4567",
      pubkey: "p".repeat(64),
      proof: `proof:node-a:${"p".repeat(64)}:token-a`,
      oneWay: false,
    });
    expect(h.addCalls.at(-1)).toMatchObject({
      alias: "remote",
      url: "http://remote",
      node: "remote",
      pubkey: "r".repeat(64),
      identity: { oracle: "remote-oracle", node: "remote" },
      markSymmetricCheck: true,
    });
  });
});
