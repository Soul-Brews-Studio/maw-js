import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";

const oldMawHome = process.env.MAW_HOME;
const oldMawConfigDir = process.env.MAW_CONFIG_DIR;

delete process.env.MAW_HOME;
delete process.env.MAW_CONFIG_DIR;
process.env.MAW_TEST_MODE = "1";

const { CONFIG_FILE } = await import("../../src/core/paths.ts");
const { saveConfig } = await import("../../src/config/load.ts");

if (oldMawHome === undefined) delete process.env.MAW_HOME;
else process.env.MAW_HOME = oldMawHome;
if (oldMawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
else process.env.MAW_CONFIG_DIR = oldMawConfigDir;

describe("config load real-home guard coverage", () => {
  test("saveConfig refuses the real homedir config under MAW_TEST_MODE", () => {
    const realHomeConfig = join(homedir(), ".config", "maw", "maw.config.json");
    if (process.env.MAW_ALLOW_REAL_HOME_GUARD_COVERAGE !== "1") return;
    if (CONFIG_FILE !== realHomeConfig) return;

    expect(() => saveConfig({ host: "must-not-write" })).toThrow(/saveConfig refused/);
  });
});
