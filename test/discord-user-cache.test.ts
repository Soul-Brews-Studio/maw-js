import { afterEach, describe, expect, it } from "bun:test";
import {
  DISCORD_USER_CACHE_DEFAULT_MAX,
  DISCORD_USER_CACHE_MAX_ENV,
  cacheDiscordUserName,
  clearDiscordUserCacheForTests,
  getCachedDiscordUserName,
  getDiscordUserCacheMaxSize,
  snapshotDiscordUserCacheForTests,
} from "../src/vendor/mpr-plugins/discord/inventory";

const previousMax = process.env[DISCORD_USER_CACHE_MAX_ENV];

afterEach(() => {
  clearDiscordUserCacheForTests();
  if (previousMax === undefined) delete process.env[DISCORD_USER_CACHE_MAX_ENV];
  else process.env[DISCORD_USER_CACHE_MAX_ENV] = previousMax;
});

describe("Discord user cache", () => {
  it("defaults to 1000 entries", () => {
    delete process.env[DISCORD_USER_CACHE_MAX_ENV];
    expect(DISCORD_USER_CACHE_DEFAULT_MAX).toBe(1000);
    expect(getDiscordUserCacheMaxSize()).toBe(1000);
  });

  it("uses a configurable non-negative max size from the environment", () => {
    process.env[DISCORD_USER_CACHE_MAX_ENV] = "2";
    expect(getDiscordUserCacheMaxSize()).toBe(2);

    process.env[DISCORD_USER_CACHE_MAX_ENV] = "not-a-number";
    expect(getDiscordUserCacheMaxSize()).toBe(1000);
  });

  it("evicts oldest entries when the configured max is exceeded", () => {
    process.env[DISCORD_USER_CACHE_MAX_ENV] = "2";

    cacheDiscordUserName("u1", "one");
    cacheDiscordUserName("u2", "two");
    cacheDiscordUserName("u3", "three");

    expect(snapshotDiscordUserCacheForTests()).toEqual([
      ["u2", "two"],
      ["u3", "three"],
    ]);
    expect(getCachedDiscordUserName("u1")).toBeUndefined();
  });

  it("supports max size 0 to disable retained cache entries", () => {
    process.env[DISCORD_USER_CACHE_MAX_ENV] = "0";

    cacheDiscordUserName("u1", "one");

    expect(snapshotDiscordUserCacheForTests()).toEqual([]);
    expect(getCachedDiscordUserName("u1")).toBeUndefined();
  });

  it("refreshes recency on cache hits", () => {
    process.env[DISCORD_USER_CACHE_MAX_ENV] = "2";

    cacheDiscordUserName("u1", "one");
    cacheDiscordUserName("u2", "two");
    expect(getCachedDiscordUserName("u1")).toBe("one");
    cacheDiscordUserName("u3", "three");

    expect(snapshotDiscordUserCacheForTests()).toEqual([
      ["u1", "one"],
      ["u3", "three"],
    ]);
    expect(getCachedDiscordUserName("u2")).toBeUndefined();
  });
});
