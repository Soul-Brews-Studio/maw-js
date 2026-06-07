import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalPeersFile = process.env.PEERS_FILE;
const originalHome = process.env.HOME;
const originalMawHome = process.env.MAW_HOME;
const originalMawStateDir = process.env.MAW_STATE_DIR;
let root = "";
let peersFile = "";

const killPeerResolve = await import(
  "../../src/vendor/mpr-plugins/kill/internal/peer-resolve.ts?vendor-peer-resolve-coverage-kill"
);
const wakePeerResolve = await import(
  "../../src/vendor/mpr-plugins/wake/internal/peer-resolve.ts?vendor-peer-resolve-coverage-wake"
);
const lsPeerResolve = await import(
  "../../src/vendor/mpr-plugins/ls/internal/peer-resolve.ts?vendor-peer-resolve-coverage-ls"
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-peer-resolve-"));
  peersFile = join(root, "peers.json");
  process.env.PEERS_FILE = peersFile;
});

afterEach(() => {
  if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = originalPeersFile;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalMawStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalMawStateDir;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("vendor kill/wake peer alias resolvers", () => {
  test("return null for missing and unreadable peer stores", () => {
    expect(killPeerResolve.resolvePeer("white")).toBeNull();
    expect(wakePeerResolve.resolvePeer("white")).toBeNull();

    writeFileSync(peersFile, "{ not json", "utf-8");

    expect(killPeerResolve.resolvePeer("white")).toBeNull();
    expect(wakePeerResolve.resolvePeer("white")).toBeNull();
  });

  test("return null for unknown aliases and entries without string URLs", () => {
    writeFileSync(peersFile, JSON.stringify({
      peers: {
        missingUrl: { node: "node-only" },
        numericUrl: { url: 123, node: "bad-url" },
      },
    }), "utf-8");

    expect(killPeerResolve.resolvePeer("ghost")).toBeNull();
    expect(killPeerResolve.resolvePeer("missingUrl")).toBeNull();
    expect(wakePeerResolve.resolvePeer("numericUrl")).toBeNull();
  });

  test("resolve URLs and normalize non-string node metadata to null", () => {
    writeFileSync(peersFile, JSON.stringify({
      peers: {
        white: { url: "http://white.local:3456", node: "white-node" },
        mba: { url: "https://mba.local", node: false },
      },
    }), "utf-8");

    expect(killPeerResolve.resolvePeer("white")).toEqual({
      url: "http://white.local:3456",
      node: "white-node",
    });
    expect(wakePeerResolve.resolvePeer("white")).toEqual({
      url: "http://white.local:3456",
      node: "white-node",
    });
    expect(killPeerResolve.resolvePeer("mba")).toEqual({
      url: "https://mba.local",
      node: null,
    });
    expect(wakePeerResolve.resolvePeer("mba")).toEqual({
      url: "https://mba.local",
      node: null,
    });
  });

  test("state store wins, with legacy home peers as a read fallback", () => {
    delete process.env.PEERS_FILE;
    delete process.env.MAW_HOME;
    process.env.HOME = join(root, "home");
    process.env.MAW_STATE_DIR = join(root, "state");

    const legacyDir = join(process.env.HOME, ".maw");
    const legacyFile = join(legacyDir, "peers.json");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, JSON.stringify({
      version: 1,
      peers: {
        white: { url: "http://legacy-white:3456", node: "legacy-node" },
      },
    }), "utf-8");

    expect(killPeerResolve.resolvePeer("white")).toEqual({ url: "http://legacy-white:3456", node: "legacy-node" });
    expect(wakePeerResolve.resolvePeer("white")).toEqual({ url: "http://legacy-white:3456", node: "legacy-node" });
    expect(lsPeerResolve.resolvePeer("white")).toEqual({ alias: "white", url: "http://legacy-white:3456", node: "legacy-node" });
    expect(lsPeerResolve.resolveAllPeers()).toEqual([{ alias: "white", url: "http://legacy-white:3456", node: "legacy-node" }]);

    mkdirSync(process.env.MAW_STATE_DIR, { recursive: true });
    writeFileSync(join(process.env.MAW_STATE_DIR, "peers.json"), JSON.stringify({
      version: 1,
      peers: {
        white: { url: "http://state-white:3456", node: "state-node" },
      },
    }), "utf-8");

    expect(killPeerResolve.resolvePeer("white")).toEqual({ url: "http://state-white:3456", node: "state-node" });
    expect(wakePeerResolve.resolvePeer("white")).toEqual({ url: "http://state-white:3456", node: "state-node" });
    expect(lsPeerResolve.resolvePeer("white")).toEqual({ alias: "white", url: "http://state-white:3456", node: "state-node" });
  });
});
