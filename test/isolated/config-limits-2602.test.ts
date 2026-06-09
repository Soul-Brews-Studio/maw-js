/** @maw-test-isolate */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalTestMode = process.env.MAW_TEST_MODE;
const configDir = mkdtempSync(join(tmpdir(), "maw-config-limits-2602-"));
process.env.MAW_CONFIG_DIR = configDir;
process.env.MAW_TEST_MODE = "1";
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "maw.config.50.json"), JSON.stringify({
  limits: {
    maxConcurrentAgents: 20,
    feedMax: 123,
  },
}, null, 2));

const config = await import(`../../src/config/load.ts?limits2602=${Date.now()}`);
const validate = await import(`../../src/config/validate-ext.ts?limits2602=${Date.now()}`);

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalTestMode;
  rmSync(configDir, { recursive: true, force: true });
});

describe("config limits validation (#2602)", () => {
  test("limits.maxConcurrentAgents survives config load and provenance", () => {
    config.resetConfig();
    const loaded = config.loadConfigWithProvenance();

    expect(loaded.config.limits?.maxConcurrentAgents).toBe(20);
    expect(loaded.config.limits?.feedMax).toBe(123);
    expect(config.cfgLimit("maxConcurrentAgents")).toBe(20);
    expect(loaded.provenance["limits.maxConcurrentAgents"]?.at(-1)).toMatchObject({
      path: join(configDir, "maw.config.50.json"),
      value: 20,
      action: "set",
    });
  });

  test("limits validator keeps non-negative numbers and drops invalid entries", () => {
    const sanitized = validate.validateConfig({ limits: { maxConcurrentAgents: 0, bad: -1, nope: "10" } });

    expect(sanitized.limits).toEqual({ maxConcurrentAgents: 0 });
  });
});
