/**
 * maw pair — handshake API tests (#573).
 *
 * Drives pairApi directly via Elysia's .handle(Request) — no real
 * Bun.serve, no network. Verifies:
 *   - POST /pair/generate returns code + ttl
 *   - GET  /pair/:code/probe — 200 for live, 404 for unknown
 *   - POST /pair/:code — success writes initiator peer, returns token
 *   - POST /pair/:code (replay) — rejected with 410
 *   - GET  /pair/:code/status — consumed flag flip
 *   - invalid shape → 400
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "maw-pair-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
  const { _resetStore } = await import("../src/commands/plugins/pair/codes");
  const { _resetResults } = await import("../src/api/pair");
  _resetStore();
  _resetResults();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

async function call(path: string, init?: RequestInit) {
  const { pairApi } = await import("../src/api/pair");
  const req = new Request(`http://local${path}`, init);
  const res = await pairApi.handle(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

describe("pair API — generate + probe", () => {
  it("POST /pair/generate returns a valid code with TTL", async () => {
    const { status, json } = await call("/pair/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMs: 60000 }),
    });
    expect(status).toBe(201);
    expect(json.ok).toBe(true);
    expect(typeof json.code).toBe("string");
    expect(json.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(json.expiresAt).toBeGreaterThan(Date.now());
  });

  it("GET /pair/:code/probe — 404 for unknown code", async () => {
    const { status, json } = await call("/pair/ABCDEF/probe");
    expect(status).toBe(404);
    expect(json.error).toBe("not_found");
  });

  it("GET /pair/:code/probe — 400 for invalid shape", async () => {
    const { status, json } = await call("/pair/BAD/probe");
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_shape");
  });

  it("GET /pair/:code/probe — 200 for live code", async () => {
    const gen = await call("/pair/generate", { method: "POST" });
    const code = gen.json.code.replace("-", "");
    const { status, json } = await call(`/pair/${code}/probe`);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

describe("pair API — handshake + consume", () => {
  async function newCode() {
    const gen = await call("/pair/generate", { method: "POST" });
    return gen.json.code.replace("-", "");
  }

  it("POST /pair/:code succeeds with body {node,url} and returns federationToken", async () => {
    const code = await newCode();
    const { status, json } = await call(`/pair/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "mba", url: "http://fake.invalid:3456" }),
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.federationToken).toBe("string");
    expect(json.federationToken.length).toBeGreaterThanOrEqual(32);
  });

  it("replay: second POST /pair/:code returns 410 consumed", async () => {
    const code = await newCode();
    const body = JSON.stringify({ node: "mba", url: "http://fake.invalid:3456" });
    const first = await call(`/pair/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(first.status).toBe(200);
    const second = await call(`/pair/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(second.status).toBe(410);
    expect(second.json.error).toBe("consumed");
  });

  it("POST /pair/:code with missing body fields → 400 bad_request", async () => {
    const code = await newCode();
    const { status, json } = await call(`/pair/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "mba" }),
    });
    expect(status).toBe(400);
    expect(json.error).toBe("bad_request");
  });

  it("POST /pair/:code with bad shape → 400 invalid_shape", async () => {
    const { status, json } = await call(`/pair/XXX`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "mba", url: "http://fake.invalid:3456" }),
    });
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_shape");
  });

  it("GET /pair/:code/status reflects consumption", async () => {
    const code = await newCode();
    const before = await call(`/pair/${code}/status`);
    expect(before.json.consumed).toBe(false);
    await call(`/pair/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "mba", url: "http://fake.invalid:3456" }),
    });
    const after = await call(`/pair/${code}/status`);
    expect(after.json.consumed).toBe(true);
    expect(after.json.remoteNode).toBe("mba");
  });

  it("successful handshake writes peer to peers.json (initiator side)", async () => {
    const code = await newCode();
    await call(`/pair/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "mba", url: "http://fake.invalid:3456" }),
    });
    const { loadPeers } = await import("../src/commands/plugins/peers/store");
    const peers = loadPeers();
    expect(peers.peers["mba"]?.url).toBe("http://fake.invalid:3456");
    expect(peers.peers["mba"]?.node).toBe("mba");
  });
});
