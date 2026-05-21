import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  isMawXdgEnabled,
  mawCacheDir,
  mawCachePath,
  mawConfigDir,
  mawConfigPath,
  mawDataDir,
  mawDataPath,
  mawRuntimeHomeDir,
  mawStateDir,
  mawStatePath,
} from "../src/core/xdg";

const ENV_KEYS = [
  "MAW_HOME",
  "MAW_CONFIG_DIR",
  "MAW_DATA_DIR",
  "MAW_STATE_DIR",
  "MAW_CACHE_DIR",
  "MAW_XDG",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(resetEnv);

describe("maw XDG path resolver", () => {
  test("keeps legacy maw home defaults until MAW_XDG is enabled", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(isMawXdgEnabled()).toBe(false);
    expect(mawRuntimeHomeDir()).toBe(join(homedir(), ".maw"));
    expect(mawDataDir()).toBe(join(homedir(), ".maw"));
    expect(mawStateDir()).toBe(join(homedir(), ".maw"));
    expect(mawCacheDir()).toBe(join(homedir(), ".maw"));
    expect(mawConfigDir()).toBe(join(homedir(), ".config", "maw"));
    expect(mawDataPath("plugins")).toBe(join(homedir(), ".maw", "plugins"));
    expect(mawStatePath("peers.json")).toBe(join(homedir(), ".maw", "peers.json"));
    expect(mawCachePath("registry-cache.json")).toBe(join(homedir(), ".maw", "registry-cache.json"));
    expect(mawConfigPath("maw.config.json")).toBe(join(homedir(), ".config", "maw", "maw.config.json"));
  });

  test("MAW_XDG flips runtime data/state/cache to XDG bases", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MAW_XDG = "yes";
    process.env.XDG_DATA_HOME = "/xdg-data";
    process.env.XDG_STATE_HOME = "/xdg-state";
    process.env.XDG_CACHE_HOME = "/xdg-cache";
    process.env.XDG_CONFIG_HOME = "/xdg-config";

    expect(isMawXdgEnabled()).toBe(true);
    expect(mawRuntimeHomeDir()).toBe("/xdg-state/maw");
    expect(mawDataDir()).toBe("/xdg-data/maw");
    expect(mawStateDir()).toBe("/xdg-state/maw");
    expect(mawCacheDir()).toBe("/xdg-cache/maw");
    expect(mawConfigDir()).toBe("/xdg-config/maw");
  });

  test("explicit maw env overrides beat XDG mode", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MAW_XDG = "1";
    process.env.MAW_CONFIG_DIR = "/maw-config";
    process.env.MAW_DATA_DIR = "/maw-data";
    process.env.MAW_STATE_DIR = "/maw-state";
    process.env.MAW_CACHE_DIR = "/maw-cache";

    expect(mawConfigDir()).toBe("/maw-config");
    expect(mawDataDir()).toBe("/maw-data");
    expect(mawStateDir()).toBe("/maw-state");
    expect(mawCacheDir()).toBe("/maw-cache");
  });

  test("MAW_HOME keeps instance mode isolated and ignores relative XDG bases", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MAW_HOME = "/maw-home";
    process.env.MAW_XDG = "on";
    process.env.XDG_DATA_HOME = "relative-data";
    process.env.XDG_STATE_HOME = "relative-state";
    process.env.XDG_CACHE_HOME = "relative-cache";

    expect(mawRuntimeHomeDir()).toBe("/maw-home");
    expect(mawConfigDir()).toBe("/maw-home/config");
    expect(mawDataDir()).toBe("/maw-home");
    expect(mawStateDir()).toBe("/maw-home");
    expect(mawCacheDir()).toBe("/maw-home");
  });

  test("relative XDG env vars are ignored when MAW_HOME is absent", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MAW_XDG = "true";
    process.env.XDG_DATA_HOME = "relative-data";
    process.env.XDG_STATE_HOME = "relative-state";
    process.env.XDG_CACHE_HOME = "relative-cache";
    process.env.XDG_CONFIG_HOME = "relative-config";

    expect(mawDataDir()).toBe(join(homedir(), ".local", "share", "maw"));
    expect(mawStateDir()).toBe(join(homedir(), ".local", "state", "maw"));
    expect(mawCacheDir()).toBe(join(homedir(), ".cache", "maw"));
    expect(mawConfigDir()).toBe(join(homedir(), ".config", "maw"));
  });
});
