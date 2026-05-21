import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as realOs from "os";

const originalMawHome = process.env.MAW_HOME;
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let homeDir = mkdtempSync(join(tmpdir(), "maw-paths-home-"));

mock.module("os", () => ({
  ...realOs,
  homedir: () => homeDir,
}));

async function importPaths(label: string) {
  return import(`${process.cwd()}/src/core/paths.ts?coverage=${label}-${Date.now()}-${Math.random()}`);
}

beforeEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  homeDir = mkdtempSync(join(tmpdir(), "maw-paths-home-"));
  delete process.env.MAW_HOME;
  delete process.env.MAW_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
});

afterAll(() => {
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("core paths", () => {
  test("defaults to singleton home and ~/.config/maw config directory", async () => {
    const paths = await importPaths("default");

    expect(paths.resolveHome()).toBe(join(homeDir, ".maw"));
    expect(paths.CONFIG_DIR).toBe(join(homeDir, ".config", "maw"));
    expect(paths.FLEET_DIR).toBe(join(homeDir, ".config", "maw", "fleet"));
    expect(paths.CONFIG_FILE).toBe(join(homeDir, ".config", "maw", "maw.config.json"));
    expect(existsSync(paths.FLEET_DIR)).toBe(true);
    expect(paths.MAW_ROOT).toMatch(/src$/);
  });

  test("MAW_HOME controls both runtime home and config directory", async () => {
    const mawHome = mkdtempSync(join(tmpdir(), "maw-instance-home-"));
    process.env.MAW_HOME = mawHome;
    process.env.MAW_CONFIG_DIR = join(homeDir, "ignored-config");

    try {
      const paths = await importPaths("maw-home");

      expect(paths.resolveHome()).toBe(mawHome);
      expect(paths.CONFIG_DIR).toBe(join(mawHome, "config"));
      expect(paths.FLEET_DIR).toBe(join(mawHome, "config", "fleet"));
      expect(paths.CONFIG_FILE).toBe(join(mawHome, "config", "maw.config.json"));
      expect(existsSync(paths.FLEET_DIR)).toBe(true);
    } finally {
      rmSync(mawHome, { recursive: true, force: true });
    }
  });

  test("MAW_CONFIG_DIR overrides singleton config when MAW_HOME is unset", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "maw-config-dir-"));
    process.env.MAW_CONFIG_DIR = configDir;

    try {
      const paths = await importPaths("config-dir");

      expect(paths.resolveHome()).toBe(join(homeDir, ".maw"));
      expect(paths.CONFIG_DIR).toBe(configDir);
      expect(paths.FLEET_DIR).toBe(join(configDir, "fleet"));
      expect(paths.CONFIG_FILE).toBe(join(configDir, "maw.config.json"));
      expect(existsSync(paths.FLEET_DIR)).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
