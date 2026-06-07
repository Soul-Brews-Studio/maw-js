import { describe, expect, mock, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const oldTestMode = process.env.MAW_TEST_MODE;
const realConfigDir = join(homedir(), ".config", "maw");
const realConfigFile = join(realConfigDir, "maw.config.json");

mock.module(join(root, "src/core/paths"), () => ({
  CONFIG_FILE: realConfigFile,
  CONFIG_DIR: realConfigDir,
  BASE_DIR: realConfigDir,
  FLEET_DIR: join(realConfigDir, "fleet"),
  MAW_ROOT: root,
  resolveHome: () => join(homedir(), ".maw"),
}));

const { saveConfig } = await import(`../../src/config/load.ts?coverage-100b-real-home-load=${Date.now()}-${Math.random()}`);

describe("coverage 100b config real-home guard", () => {
  test("saveConfig throws before writing when test mode resolves to real homedir", () => {
    process.env.MAW_TEST_MODE = "1";
    try {
      expect(() => saveConfig({ host: "must-not-write" })).toThrow(/import is resolved \(see src\/core\/paths\.ts\)/);
    } finally {
      if (oldTestMode === undefined) delete process.env.MAW_TEST_MODE;
      else process.env.MAW_TEST_MODE = oldTestMode;
    }
  });
});
