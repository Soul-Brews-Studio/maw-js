import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFederationApi, type FederationApiDeps } from "../src/api/federation";

function makeApp(deps: FederationApiDeps = {}) {
  return new Elysia().use(createFederationApi(deps));
}

async function readJson(res: Response) {
  return await res.json() as any;
}

describe("federation API identity/status/snapshot routes", () => {
  test("serves federation status, snapshots, identity, and auth status", async () => {
    const app = makeApp({
      getFederationStatus: async () => ({ peers: [{ name: "m5" }] }) as any,
      listSnapshots: () => [{ id: "s1" }] as any,
      loadSnapshot: (id: string) => id === "s1" ? ({ id, sessions: [] }) as any : null,
      loadConfig: (() => ({
        node: "m5",
        nodeUser: "codex",
        port: 4567,
        oracle: "mawjs-oracle",
        agents: { codex: "m5", buddy: "codex@m5" },
        federationToken: "abcd-secret",
      })) as any,
      hostedAgents: ((agents: any, node: string) => Object.entries(agents)
        .filter(([, n]) => n === node)
        .map(([name]) => ({ node, name }))) as any,
      getPeerKey: () => "peer-public-key",
      packageVersion: "v.test",
      uptime: () => 42.9,
      nowIso: () => "2026-05-17T00:00:00.000Z",
    });

    expect(await readJson(await app.handle(new Request("http://localhost/federation/status")))).toEqual({ peers: [{ name: "m5" }] });
    expect(await readJson(await app.handle(new Request("http://localhost/snapshots")))).toEqual([{ id: "s1" }]);
    expect(await readJson(await app.handle(new Request("http://localhost/snapshots/s1")))).toEqual({ id: "s1", sessions: [] });

    const missing = await app.handle(new Request("http://localhost/snapshots/missing"));
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toEqual({ error: "snapshot not found" });

    expect(await readJson(await app.handle(new Request("http://localhost/identity")))).toEqual({
      node: "codex@m5",
      host: "m5",
      user: "codex",
      port: 4567,
      oracle: "mawjs-oracle",
      version: "v.test",
      agents: [{ node: "codex@m5", name: "buddy" }, { node: "m5", name: "codex" }],
      uptime: 42,
      clockUtc: "2026-05-17T00:00:00.000Z",
      endpoints: [
        "/api/identity",
        "/api/messages",
        "/api/pane-keys",
        "/api/probe",
        "/api/send",
        "/api/sleep",
        "/api/wake",
      ],
      pubkey: "peer-public-key",
    });

    expect(await readJson(await app.handle(new Request("http://localhost/auth/status")))).toEqual({
      enabled: true,
      tokenConfigured: true,
      tokenPreview: "abcd****",
      method: "HMAC-SHA256",
      clockUtc: "2026-05-17T00:00:00.000Z",
      node: "m5",
    });
  });

  test("identity and auth status default missing config fields", async () => {
    const app = makeApp({
      loadConfig: (() => ({})) as any,
      hostedAgents: (() => []) as any,
      getPeerKey: () => "pub",
      packageVersion: "v.test",
      uptime: () => 1,
      nowIso: () => "now",
    });

    expect((await readJson(await app.handle(new Request("http://localhost/identity")))).node).toBe("local");
    expect(await readJson(await app.handle(new Request("http://localhost/auth/status")))).toEqual({
      enabled: false,
      tokenConfigured: false,
      tokenPreview: null,
      method: "none",
      clockUtc: "now",
      node: "local",
    });
  });

  test("production default callbacks remain callable without writing peer keys", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "maw-federation-api-"));
    const savedPeerKey = process.env.MAW_PEER_KEY;
    const savedConfigDir = process.env.MAW_CONFIG_DIR;
    const savedDataDir = process.env.MAW_DATA_DIR;
    process.env.MAW_PEER_KEY = "test-peer-key";
    process.env.MAW_CONFIG_DIR = tmp;
    process.env.MAW_DATA_DIR = join(tmp, "data");
    try {
      const app = makeApp({
        homedir: () => tmp,
        readFileSync: (() => { throw new Error("no legacy log"); }) as any,
      });

      const identity = await readJson(await app.handle(new Request("http://localhost/identity")));
      expect(identity.pubkey).toBe("test-peer-key");
      expect(typeof identity.uptime).toBe("number");
      expect(typeof identity.clockUtc).toBe("string");

      const messages = await readJson(await app.handle(new Request("http://localhost/messages?limit=1")));
      expect(messages).toEqual({ messages: [], total: 0 });
    } finally {
      if (savedPeerKey === undefined) delete process.env.MAW_PEER_KEY;
      else process.env.MAW_PEER_KEY = savedPeerKey;
      if (savedConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
      else process.env.MAW_CONFIG_DIR = savedConfigDir;
      if (savedDataDir === undefined) delete process.env.MAW_DATA_DIR;
      else process.env.MAW_DATA_DIR = savedDataDir;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("federation API messages route", () => {
  test("returns sqlite ledger messages with bounded query options", async () => {
    const calls: any[] = [];
    const app = makeApp({
      loadLedger: async () => ({
        listMessageLedgerEvents: (query: any) => {
          calls.push(query);
          return [{ id: 1, from: "a", to: "b", body: "hello" }];
        },
        messageLedgerDbPath: () => "/tmp/messages.sqlite",
      }),
    });

    const res = await app.handle(new Request("http://localhost/messages?from=a&to=b&limit=5000&direction=out&state=sent&q=hel"));

    expect(await readJson(res)).toEqual({
      messages: [{ id: 1, from: "a", to: "b", body: "hello" }],
      total: 1,
      source: "sqlite",
      dbPath: "/tmp/messages.sqlite",
    });
    expect(calls).toEqual([{ from: "a", to: "b", limit: 1000, direction: "out", state: "sent", q: "hel" }]);
  });

  test("falls back to legacy JSONL log with filters, invalid-line skip, and limit", async () => {
    const app = makeApp({
      homedir: () => "/home/test",
      join: ((...parts: string[]) => parts.join("/")) as any,
      loadLedger: async () => ({
        listMessageLedgerEvents: () => [],
        messageLedgerDbPath: () => "/unused",
      }),
      readFileSync: ((path: string) => {
        expect(path).toBe("/home/test/.oracle/maw-log.jsonl");
        return [
          JSON.stringify({ ts: "1", from: "alice", to: "maw", msg: "old" }),
          "not-json",
          JSON.stringify({ ts: "2", from: "alice", to: "maw", msg: "newer" }),
          JSON.stringify({ ts: "3", from: "bob", to: "maw", msg: "skip" }),
        ].join("\n");
      }) as any,
    });

    const res = await app.handle(new Request("http://localhost/messages?from=ali&to=maw&limit=1"));

    expect(await readJson(res)).toEqual({
      messages: [{ ts: "2", from: "alice", to: "maw", msg: "newer" }],
      total: 2,
    });
  });

  test("falls back to empty messages when sqlite and JSONL both fail", async () => {
    const app = makeApp({
      loadLedger: async () => { throw new Error("sqlite missing"); },
      readFileSync: (() => { throw new Error("no jsonl"); }) as any,
    });

    expect(await readJson(await app.handle(new Request("http://localhost/messages")))).toEqual({ messages: [], total: 0 });
  });
});

describe("federation API fleet route", () => {
  test("serves active fleet configs and skips disabled or invalid files", async () => {
    const app = makeApp({
      fleetDir: "/fleet",
      join: ((...parts: string[]) => parts.join("/")) as any,
      readdirSync: ((dir: string) => {
        expect(dir).toBe("/fleet");
        return ["m5.json", "bad.json", "off.json.disabled", "notes.txt"] as any;
      }) as any,
      readFileSync: ((path: string) => {
        if (path === "/fleet/m5.json") return JSON.stringify({ node: "m5" });
        throw new Error("bad json");
      }) as any,
    });

    expect(await readJson(await app.handle(new Request("http://localhost/fleet")))).toEqual({
      fleet: [{ file: "m5.json", node: "m5" }],
    });
  });

  test("returns an empty fleet when the fleet directory cannot be read", async () => {
    const app = makeApp({ readdirSync: (() => { throw new Error("missing fleet"); }) as any });

    expect(await readJson(await app.handle(new Request("http://localhost/fleet")))).toEqual({ fleet: [] });
  });
});
