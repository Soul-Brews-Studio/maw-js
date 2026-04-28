/**
 * Tests for cmdOracleSetNickname, cmdOracleGetNickname from
 * src/commands/plugins/oracle/impl-nickname.ts.
 * Uses mock.module to stub SDK readCache and nicknames module.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockCacheOracles: any[] = [];
const writtenNicknames: { path: string; value: string }[] = [];
const cachedNicknames: Record<string, string> = {};
let mockResolvedNickname: string | null = null;

const _rSdk = await import("../../src/sdk");

mock.module("../../src/sdk", () => ({
  ..._rSdk,
  readCache: () =>
    mockCacheOracles.length > 0
      ? { oracles: mockCacheOracles, local_scanned_at: new Date().toISOString() }
      : null,
}));

mock.module("../../src/core/fleet/nicknames", () => ({
  validateNickname: (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, value: "" };
    if (/[\r\n]/.test(trimmed)) return { ok: false, error: "nickname must be a single line (no newlines)" };
    if (trimmed.length > 64) return { ok: false, error: `nickname too long (${trimmed.length} > 64)` };
    return { ok: true, value: trimmed };
  },
  writeNickname: (path: string, value: string) => {
    writtenNicknames.push({ path, value });
  },
  setCachedNickname: (name: string, value: string) => {
    if (value === "") delete cachedNicknames[name];
    else cachedNicknames[name] = value;
  },
  resolveNickname: (_name: string, _repoPath: string | null) => mockResolvedNickname,
}));

mock.module("../../src/config", () => ({
  loadConfig: () => ({}),
  saveConfig: () => {},
  buildCommand: (n: string) => `echo ${n}`,
  buildCommandInDir: (n: string, d: string) => `echo ${n}`,
  cfgTimeout: () => 100,
  cfgLimit: () => 200,
  cfgInterval: () => 5000,
  cfg: () => undefined,
  D: { hmacWindowSeconds: 30 },
  getEnvVars: () => ({}),
  resetConfig: () => {},
}));

mock.module("../../src/core/paths", () => ({
  CONFIG_DIR: "/tmp/maw-test",
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_FILE: "/tmp/maw-test/maw.config.json",
  MAW_ROOT: "/tmp/maw-test",
  resolveHome: () => "/tmp/maw-test",
}));

const { cmdOracleSetNickname, cmdOracleGetNickname } = await import(
  "../../src/commands/plugins/oracle/impl-nickname"
);

beforeEach(() => {
  mockCacheOracles = [];
  writtenNicknames.length = 0;
  for (const k of Object.keys(cachedNicknames)) delete cachedNicknames[k];
  mockResolvedNickname = null;
});

describe("cmdOracleSetNickname", () => {
  it("throws on empty name", () => {
    expect(() => cmdOracleSetNickname("", "nick")).toThrow("usage:");
  });

  it("throws when oracle not found in cache", () => {
    mockCacheOracles = [];
    expect(() => cmdOracleSetNickname("unknown", "nick")).toThrow("not found");
  });

  it("throws when oracle has no local path", () => {
    mockCacheOracles = [{ name: "neo", local_path: "" }];
    expect(() => cmdOracleSetNickname("neo", "nick")).toThrow("no local path");
  });

  it("throws on invalid nickname (newlines)", () => {
    mockCacheOracles = [{ name: "neo", local_path: "/tmp/neo" }];
    expect(() => cmdOracleSetNickname("neo", "a\nb")).toThrow("single line");
  });

  it("writes nickname to disk and cache", () => {
    mockCacheOracles = [{ name: "neo", local_path: "/tmp/neo" }];
    cmdOracleSetNickname("neo", "The One");
    expect(writtenNicknames).toHaveLength(1);
    expect(writtenNicknames[0]).toEqual({ path: "/tmp/neo", value: "The One" });
    expect(cachedNicknames["neo"]).toBe("The One");
  });

  it("clears nickname with empty string", () => {
    mockCacheOracles = [{ name: "neo", local_path: "/tmp/neo" }];
    cachedNicknames["neo"] = "OldNick";
    cmdOracleSetNickname("neo", "");
    expect(writtenNicknames[0].value).toBe("");
    expect(cachedNicknames["neo"]).toBeUndefined();
  });

  it("throws when cache is null (no cache)", () => {
    mockCacheOracles = []; // readCache returns null when no oracles
    expect(() => cmdOracleSetNickname("neo", "nick")).toThrow("not found");
  });
});

describe("cmdOracleGetNickname", () => {
  it("throws on empty name", () => {
    expect(() => cmdOracleGetNickname("")).toThrow("usage:");
  });

  it("sets exitCode 1 when no nickname found", () => {
    mockCacheOracles = [{ name: "neo", local_path: "/tmp/neo" }];
    mockResolvedNickname = null;
    const savedCode = process.exitCode;
    cmdOracleGetNickname("neo");
    expect(process.exitCode).toBe(1);
    process.exitCode = savedCode; // restore
  });

  it("resolves nickname when set", () => {
    mockCacheOracles = [{ name: "neo", local_path: "/tmp/neo" }];
    mockResolvedNickname = "The One";
    // Just verify no throw — output goes to console.log
    expect(() => cmdOracleGetNickname("neo")).not.toThrow();
  });
});
