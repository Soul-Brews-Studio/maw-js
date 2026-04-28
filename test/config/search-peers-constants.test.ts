/**
 * Tests for src/commands/plugins/plugin/search-peers.ts — constants and peerCacheDir.
 * Pure/env-dependent helpers only.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  DEFAULT_PER_PEER_MS,
  DEFAULT_TOTAL_MS,
  PEER_CACHE_TTL_MS,
  peerCacheDir,
} from "../../src/commands/plugins/plugin/search-peers";

describe("search-peers constants", () => {
  it("DEFAULT_PER_PEER_MS is 2000", () => {
    expect(DEFAULT_PER_PEER_MS).toBe(2000);
  });

  it("DEFAULT_TOTAL_MS is 4000", () => {
    expect(DEFAULT_TOTAL_MS).toBe(4000);
  });

  it("PEER_CACHE_TTL_MS is 5 minutes", () => {
    expect(PEER_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("total budget >= per-peer budget", () => {
    expect(DEFAULT_TOTAL_MS).toBeGreaterThanOrEqual(DEFAULT_PER_PEER_MS);
  });
});

describe("peerCacheDir", () => {
  const origEnv = process.env.MAW_PEER_CACHE_DIR;

  afterEach(() => {
    if (origEnv !== undefined) process.env.MAW_PEER_CACHE_DIR = origEnv;
    else delete process.env.MAW_PEER_CACHE_DIR;
  });

  it("uses override when provided", () => {
    expect(peerCacheDir("/custom/path")).toBe("/custom/path");
  });

  it("uses MAW_PEER_CACHE_DIR env when set", () => {
    process.env.MAW_PEER_CACHE_DIR = "/env/cache";
    expect(peerCacheDir()).toBe("/env/cache");
  });

  it("defaults to ~/.maw/peer-manifest-cache", () => {
    delete process.env.MAW_PEER_CACHE_DIR;
    const result = peerCacheDir();
    expect(result).toContain("peer-manifest-cache");
    expect(result).toContain(".maw");
  });

  it("override takes precedence over env", () => {
    process.env.MAW_PEER_CACHE_DIR = "/env/cache";
    expect(peerCacheDir("/override")).toBe("/override");
  });
});
