/**
 * Tests for src/commands/plugins/peers/store.ts — loadPeers, savePeers, mutatePeers
 * using PEERS_FILE env override for test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPeers, savePeers, mutatePeers, emptyStore, peersPath, clearStaleTmp } from "../../src/commands/plugins/peers/store";
import type { PeersFile } from "../../src/commands/plugins/peers/store";

let tmp: string;
let peersFile: string;
let origEnv: string | undefined;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-peers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  peersFile = join(tmp, "peers.json");
  origEnv = process.env.PEERS_FILE;
  process.env.PEERS_FILE = peersFile;
});

afterEach(() => {
  if (origEnv === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = origEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("emptyStore", () => {
  it("returns version 1 with empty peers", () => {
    const store = emptyStore();
    expect(store.version).toBe(1);
    expect(store.peers).toEqual({});
  });
});

describe("peersPath", () => {
  it("uses PEERS_FILE env override", () => {
    expect(peersPath()).toBe(peersFile);
  });
});

describe("loadPeers", () => {
  it("returns empty store when file does not exist", () => {
    const data = loadPeers();
    expect(data.version).toBe(1);
    expect(data.peers).toEqual({});
  });

  it("loads valid peers file", () => {
    const store: PeersFile = {
      version: 1,
      peers: {
        dev: { url: "http://localhost:3000", node: "mba", addedAt: "2026-01-01", lastSeen: "2026-01-02" },
      },
    };
    writeFileSync(peersFile, JSON.stringify(store));
    const data = loadPeers();
    expect(data.peers.dev.url).toBe("http://localhost:3000");
    expect(data.peers.dev.node).toBe("mba");
  });

  it("returns empty store for corrupt file", () => {
    writeFileSync(peersFile, "corrupt{{{json");
    const data = loadPeers();
    expect(data.peers).toEqual({});
  });

  it("renames corrupt file aside", () => {
    writeFileSync(peersFile, "corrupt{{{json");
    loadPeers();
    // Original file should be renamed, not deleted
    expect(existsSync(peersFile)).toBe(false);
  });

  it("rejects array-shaped peers (invalid shape)", () => {
    writeFileSync(peersFile, JSON.stringify({ peers: [] }));
    const data = loadPeers();
    expect(data.peers).toEqual({});
  });

  it("defaults missing peers field to empty object", () => {
    writeFileSync(peersFile, JSON.stringify({ version: 1 }));
    const data = loadPeers();
    expect(data.peers).toEqual({});
  });
});

describe("savePeers", () => {
  it("creates file with proper JSON", () => {
    const store: PeersFile = { version: 1, peers: { test: { url: "http://test.com", node: "n", addedAt: "", lastSeen: null } } };
    savePeers(store);
    const raw = readFileSync(peersFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.peers.test.url).toBe("http://test.com");
  });

  it("overwrites existing file", () => {
    savePeers({ version: 1, peers: { a: { url: "http://a.com", node: null, addedAt: "", lastSeen: null } } });
    savePeers({ version: 1, peers: { b: { url: "http://b.com", node: null, addedAt: "", lastSeen: null } } });
    const data = loadPeers();
    expect(data.peers.b).toBeDefined();
    expect(data.peers.a).toBeUndefined();
  });
});

describe("mutatePeers", () => {
  it("adds a peer via mutation", () => {
    mutatePeers((data) => {
      data.peers.newpeer = { url: "http://new.com", node: "n", addedAt: "2026-01-01", lastSeen: null };
    });
    const data = loadPeers();
    expect(data.peers.newpeer.url).toBe("http://new.com");
  });

  it("removes a peer via mutation", () => {
    savePeers({ version: 1, peers: { target: { url: "http://t.com", node: null, addedAt: "", lastSeen: null } } });
    mutatePeers((data) => {
      delete data.peers.target;
    });
    const data = loadPeers();
    expect(data.peers.target).toBeUndefined();
  });

  it("returns mutated data", () => {
    const result = mutatePeers((data) => {
      data.peers.x = { url: "http://x.com", node: null, addedAt: "", lastSeen: null };
    });
    expect(result.peers.x.url).toBe("http://x.com");
  });
});

describe("clearStaleTmp", () => {
  it("removes stale tmp file", () => {
    const tmpFile = `${peersFile}.tmp`;
    writeFileSync(tmpFile, "stale");
    clearStaleTmp();
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("does not throw when no tmp file exists", () => {
    expect(() => clearStaleTmp()).not.toThrow();
  });
});
