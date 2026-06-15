import { describe, expect, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const { default: discordHandler } = await import("../../src/vendor/mpr-plugins/discord/index.ts?plugin-discord-standalone");
const {
  DISCORD_USER_CACHE_DEFAULT_MAX,
  DISCORD_USER_CACHE_MAX_ENV,
  cacheDiscordUserName,
  clearDiscordUserCacheForTests,
  getCachedDiscordUserName,
  getDiscordUserCacheMaxSize,
  snapshotDiscordUserCacheForTests,
} = await import("../../src/vendor/mpr-plugins/discord/inventory.ts?plugin-discord-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("discord plugin standalone boundary", () => {
  test("uses only SDK/plugin/platform dependencies and plugin-local imports", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "discord" });

    expect(imports.map((record) => record.spec)).toContain("maw-js/plugin/types");
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
  });

  test("keeps Discord user-name cache bounded with LRU semantics", () => {
    const previousMax = process.env[DISCORD_USER_CACHE_MAX_ENV];
    try {
      process.env[DISCORD_USER_CACHE_MAX_ENV] = "2";
      clearDiscordUserCacheForTests();

      expect(DISCORD_USER_CACHE_DEFAULT_MAX).toBe(1000);
      expect(getDiscordUserCacheMaxSize()).toBe(2);

      cacheDiscordUserName("u1", "one");
      cacheDiscordUserName("u2", "two");
      expect(getCachedDiscordUserName("u1")).toBe("one");
      cacheDiscordUserName("u3", "three");

      expect(snapshotDiscordUserCacheForTests()).toEqual([
        ["u1", "one"],
        ["u3", "three"],
      ]);
      expect(getCachedDiscordUserName("u2")).toBeUndefined();
    } finally {
      clearDiscordUserCacheForTests();
      if (previousMax === undefined) delete process.env[DISCORD_USER_CACHE_MAX_ENV];
      else process.env[DISCORD_USER_CACHE_MAX_ENV] = previousMax;
    }
  });

  test("prints usage for help forms without touching token or host state", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const result = await discordHandler({ source: "cli", args } as any);

      expect(result.ok).toBe(true);
      const output = stripAnsi(result.output);
      expect(output).toContain("usage: maw discord <subcommand> [args]");
      expect(output).toContain("tokens ls");
      expect(output).toContain("status [bot]");
      expect(output).toContain("access <bot>");
    }
  });

  test("prints plugin version and subcommand status", async () => {
    const result = await discordHandler({ source: "cli", args: ["version"] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("maw discord v");
    expect(output).toContain("subcommand status:");
    expect(output).toContain("tokens ls / check");
    expect(output).toContain("serve (after_send hook)");
  });

  test("routes planned commands to explicit not-implemented failures", async () => {
    for (const sub of ["pair", "route", "serve"]) {
      const result = await discordHandler({ source: "cli", args: [sub] } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe(`${sub} not implemented`);
      expect(stripAnsi(result.output)).toContain(`'${sub}' not implemented yet`);
    }
  });

  test("reports unknown token action and unknown top-level subcommand", async () => {
    const token = await discordHandler({ source: "cli", args: ["tokens", "wat"] } as any);
    expect(token.ok).toBe(false);
    expect(token.error).toBe("unknown action: wat");
    expect(stripAnsi(token.output)).toContain("usage: maw discord tokens <ls|check> [bot]");

    const top = await discordHandler({ source: "cli", args: ["wat"] } as any);
    expect(top.ok).toBe(false);
    expect(top.error).toBe("unknown subcommand: wat");
    expect(stripAnsi(top.output)).toContain("usage: maw discord <subcommand> [args]");
  });
});
