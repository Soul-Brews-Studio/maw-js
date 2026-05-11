import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Sandbox HOME before importing the SUT — channel-loader resolves
 * `~/.claude/channels/<stem>/config.json` via `homedir()` at module load
 * time. Without this, tests would read whatever the developer has
 * configured globally.
 */
let homeSandbox: string;
beforeAll(() => {
  homeSandbox = mkdtempSync(join(tmpdir(), "maw-channel-loader-home-"));
  process.env.HOME = homeSandbox;
});
afterAll(() => {
  try { rmSync(homeSandbox, { recursive: true, force: true }); } catch {}
});

import {
  loadEffectiveChannels,
  getChannelPluginIds,
  getChannelPermissionMode,
  saveOracleChannels,
  saveRepoChannels,
  type OracleChannelConfig,
} from "./channel-loader";

describe("loadEffectiveChannels — #1195 Phase 2 repo > global precedence", () => {
  let repoDir: string;
  const stem = "test-oracle";

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "maw-channel-loader-repo-"));
    // Clear any prior global config for this stem so tests don't pollute each other.
    try { rmSync(join(homeSandbox, ".claude", "channels", stem), { recursive: true, force: true }); } catch {}
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch {}
  });

  function globalConfig(): OracleChannelConfig {
    return { plugins: [{ id: "plugin:global-discord@1" }], permissionMode: "skip" };
  }
  function repoConfig(): OracleChannelConfig {
    return { plugins: [{ id: "plugin:repo-discord@1" }, { id: "plugin:repo-telegram@1" }], permissionMode: "relay" };
  }

  it("returns null when neither global nor repo config exists", () => {
    expect(loadEffectiveChannels(stem, repoDir)).toBeNull();
    expect(loadEffectiveChannels(stem)).toBeNull();
  });

  it("returns global when only global config exists", () => {
    saveOracleChannels(stem, globalConfig());
    const got = loadEffectiveChannels(stem, repoDir);
    expect(got?.plugins[0].id).toBe("plugin:global-discord@1");
  });

  it("returns repo when only repo config exists (no fallback needed)", () => {
    saveRepoChannels(repoDir, repoConfig());
    const got = loadEffectiveChannels(stem, repoDir);
    expect(got?.plugins.map(p => p.id)).toEqual(["plugin:repo-discord@1", "plugin:repo-telegram@1"]);
  });

  it("repo wins over global when both exist", () => {
    saveOracleChannels(stem, globalConfig());
    saveRepoChannels(repoDir, repoConfig());
    const got = loadEffectiveChannels(stem, repoDir);
    expect(got?.plugins[0].id).toBe("plugin:repo-discord@1");
    expect(got?.permissionMode).toBe("relay");
  });

  it("falls back to global when repoPath is omitted", () => {
    saveOracleChannels(stem, globalConfig());
    saveRepoChannels(repoDir, repoConfig());
    const got = loadEffectiveChannels(stem); // no repoPath
    expect(got?.plugins[0].id).toBe("plugin:global-discord@1");
  });

  it("getChannelPluginIds propagates the repo precedence", () => {
    saveOracleChannels(stem, globalConfig());
    saveRepoChannels(repoDir, repoConfig());
    expect(getChannelPluginIds(stem, undefined, repoDir)).toEqual(["plugin:repo-discord@1", "plugin:repo-telegram@1"]);
    expect(getChannelPluginIds(stem)).toEqual(["plugin:global-discord@1"]);
  });

  it("getChannelPermissionMode propagates the repo precedence", () => {
    saveOracleChannels(stem, globalConfig()); // skip
    saveRepoChannels(repoDir, repoConfig());  // relay
    expect(getChannelPermissionMode(stem, repoDir)).toBe("relay");
    expect(getChannelPermissionMode(stem)).toBe("skip");
  });

  it("fleetOverride still trumps both repo and global", () => {
    saveOracleChannels(stem, globalConfig());
    saveRepoChannels(repoDir, repoConfig());
    expect(getChannelPluginIds(stem, ["plugin:fleet@1"], repoDir)).toEqual(["plugin:fleet@1"]);
  });
});
