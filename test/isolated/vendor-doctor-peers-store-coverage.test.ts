import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  DEFAULT_STALE_TTL_MS,
  clearStaleTmp,
  emptyStore,
  getStaleTtlMs,
  isStale,
  loadPeers,
  mutatePeers,
  peersPath,
  savePeers,
  staleAgeMs,
} from "../../src/vendor/mpr-plugins/doctor/internal/peers-store";

describe("doctor vendor peers store coverage", () => {
  const originalPeersFile = process.env.PEERS_FILE;
  const originalTtl = process.env.MAW_PEER_STALE_TTL_MS;
  const originalHome = process.env.HOME;
  const originalMawHome = process.env.MAW_HOME;
  const originalStateDir = process.env.MAW_STATE_DIR;
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-doctor-peers-store-"));
    file = join(dir, "nested", "peers.json");
    process.env.PEERS_FILE = file;
    delete process.env.MAW_PEER_STALE_TTL_MS;
  });

  afterEach(() => {
    if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
    else process.env.PEERS_FILE = originalPeersFile;
    if (originalTtl === undefined) delete process.env.MAW_PEER_STALE_TTL_MS;
    else process.env.MAW_PEER_STALE_TTL_MS = originalTtl;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = originalMawHome;
    if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
    else process.env.MAW_STATE_DIR = originalStateDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("path, empty store, save/load, and stale tmp cleanup", () => {
    expect(peersPath()).toBe(file);
    expect(emptyStore()).toEqual({ version: 1, peers: {} });
    expect(loadPeers()).toEqual({ version: 1, peers: {} });

    savePeers({
      version: 1,
      peers: {
        alpha: {
          url: "http://alpha.local:3210",
          node: "alpha-node",
          addedAt: "2026-05-18T00:00:00.000Z",
          lastSeen: null,
          pubkey: "pub",
          identity: { oracle: "alpha", node: "alpha-node" },
        },
      },
    });
    writeFileSync(`${file}.tmp`, "stale partial write");

    expect(loadPeers().peers.alpha).toMatchObject({ node: "alpha-node", pubkey: "pub" });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readFileSync(file, "utf-8")).toContain("alpha-node");
  });

  test("corrupt stores are moved aside and malformed unlocked reads recover during mutation", () => {
    savePeers({ version: 1, peers: {} });
    writeFileSync(file, "{not-json");
    expect(loadPeers()).toEqual({ version: 1, peers: {} });
    expect(existsSync(file)).toBe(false);

    savePeers({ version: 1, peers: {} });
    writeFileSync(file, JSON.stringify({ version: 1, peers: [] }));
    expect(loadPeers()).toEqual({ version: 1, peers: {} });
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, JSON.stringify({ peers: [] }));
    const recovered = mutatePeers((data) => {
      data.peers.recovered = { url: "http://recovered", node: null, addedAt: "bad", lastSeen: null };
    });
    expect(Object.keys(recovered.peers)).toEqual(["recovered"]);
  });

  test("mutatePeers preserves existing peers and TTL helpers cover boundary cases", () => {
    savePeers({
      version: 1,
      peers: { before: { url: "http://before", node: null, addedAt: "2026-05-18T00:00:00.000Z", lastSeen: null } },
    });

    const data = mutatePeers((fresh) => {
      fresh.peers.after = { url: "http://after", node: "after-node", addedAt: "2026-05-18T00:00:00.000Z", lastSeen: "2026-05-18T01:00:00.000Z" };
    });
    expect(Object.keys(data.peers).sort()).toEqual(["after", "before"]);

    expect(getStaleTtlMs()).toBe(DEFAULT_STALE_TTL_MS);
    process.env.MAW_PEER_STALE_TTL_MS = "2500";
    expect(getStaleTtlMs()).toBe(2500);
    process.env.MAW_PEER_STALE_TTL_MS = "-1";
    expect(getStaleTtlMs()).toBe(DEFAULT_STALE_TTL_MS);

    const now = Date.parse("2026-05-18T12:00:00.000Z");
    expect(staleAgeMs({ url: "u", node: null, addedAt: "2026-05-18T11:59:59.000Z", lastSeen: null }, now)).toBe(1000);
    expect(staleAgeMs({ url: "u", node: null, addedAt: "bad", lastSeen: null }, now)).toBeNull();
    expect(isStale({ url: "u", node: null, addedAt: "bad", lastSeen: null }, 1000, now)).toBe(true);
    expect(isStale({ url: "u", node: null, addedAt: "2026-05-18T11:59:59.000Z", lastSeen: null }, 1000, now)).toBe(false);
  });

  test("read errors and unlocked parse errors recover as empty stores", () => {
    rmSync(file, { recursive: true, force: true });
    mkdirSync(file, { recursive: true });
    expect(loadPeers()).toEqual({ version: 1, peers: {} });

    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, "{not-json");
    const recovered = mutatePeers((data) => {
      data.peers.recovered = { url: "http://recovered", node: null, addedAt: "bad", lastSeen: null };
    });

    expect(Object.keys(recovered.peers)).toEqual(["recovered"]);
    expect(loadPeers().peers.recovered.url).toBe("http://recovered");
  });

  test("reads legacy ~/.maw peers when the XDG state store is absent", () => {
    delete process.env.PEERS_FILE;
    delete process.env.MAW_HOME;
    process.env.HOME = join(dir, "home");
    process.env.MAW_STATE_DIR = join(dir, "state");
    const legacyDir = join(process.env.HOME, ".maw");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "peers.json"), JSON.stringify({
      version: 1,
      peers: {
        legacy: { url: "http://legacy", node: null, addedAt: "2026-05-18T00:00:00.000Z", lastSeen: null },
      },
    }));

    expect(peersPath()).toBe(join(dir, "state", "peers.json"));
    expect(loadPeers().peers.legacy.url).toBe("http://legacy");
  });

  test("clearStaleTmp is best effort", () => {
    expect(() => clearStaleTmp()).not.toThrow();
    savePeers({ version: 1, peers: {} });
    writeFileSync(`${file}.tmp`, "leftover");
    clearStaleTmp();
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
