/**
 * Tests for src/config/load.ts — loadConfig, resetConfig, saveConfig,
 * configForDisplay, cfgInterval, cfgTimeout, cfgLimit, cfg.
 *
 * Isolated because we set MAW_CONFIG_DIR before any module import of paths.ts.
 * This ensures CONFIG_FILE resolves to our temp directory.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Set env BEFORE importing paths.ts (which is loaded by load.ts) ──
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-config-load-"));
mkdirSync(join(TEST_CONFIG_DIR, "fleet"), { recursive: true });
process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { D } from "../../src/config/types";
import {
  loadConfig, resetConfig, saveConfig, configForDisplay,
  cfgInterval, cfgTimeout, cfgLimit, cfg,
} from "../../src/config/load";
import { CONFIG_FILE } from "../../src/core/paths";

function writeConfig(obj: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(obj), "utf-8");
}

function removeConfig() {
  try { rmSync(CONFIG_FILE); } catch {}
}

beforeEach(() => {
  resetConfig();
  removeConfig();
});

afterAll(() => {
  delete process.env.MAW_CONFIG_DIR;
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("returns defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.host).toBe("local");
    expect(config.port).toBe(3456);
    expect(config.commands.default).toBe("claude");
  });

  test("merges config file with defaults", () => {
    writeConfig({ host: "custom", port: 5000 });
    const config = loadConfig();
    expect(config.host).toBe("custom");
    expect(config.port).toBe(5000);
    expect(config.commands.default).toBe("claude");
  });

  test("caches config on second call", () => {
    writeConfig({ host: "cached-test" });
    const first = loadConfig();
    writeConfig({ host: "changed" });
    const second = loadConfig();
    expect(second).toBe(first);
    expect(second.host).toBe("cached-test");
  });

  test("handles malformed JSON gracefully", () => {
    writeFileSync(CONFIG_FILE, "not-json{{{", "utf-8");
    const config = loadConfig();
    expect(config.host).toBe("local");
    expect(config.port).toBe(3456);
  });
});

describe("resetConfig", () => {
  test("clears cache so next loadConfig reads fresh", () => {
    writeConfig({ host: "before-reset" });
    const first = loadConfig();
    expect(first.host).toBe("before-reset");

    resetConfig();
    writeConfig({ host: "after-reset" });
    const second = loadConfig();
    expect(second.host).toBe("after-reset");
  });
});

describe("configForDisplay", () => {
  test("masks env values longer than 4 chars", () => {
    writeConfig({ env: { API_KEY: "sk-ant-1234567890" } });
    const display = configForDisplay();
    expect(display.envMasked.API_KEY).toStartWith("sk-");
    expect(display.envMasked.API_KEY).toContain("\u2022");
    expect(display.env).toEqual({});
  });

  test("masks short env values (<=4 chars) completely", () => {
    writeConfig({ env: { SHORT: "abc" } });
    const display = configForDisplay();
    expect(display.envMasked.SHORT).toBe("\u2022\u2022\u2022");
  });

  test("masks federation token to first 4 chars + bullets", () => {
    writeConfig({ federationToken: "a-very-long-secret-token-16plus" });
    const display = configForDisplay();
    expect(display.federationToken).toStartWith("a-ve");
    expect(display.federationToken).toContain("\u2022");
  });

  test("handles no env gracefully", () => {
    const display = configForDisplay();
    expect(display.envMasked).toEqual({});
  });
});

// NOTE: intervals, timeouts, limits are defined in MawConfig types but
// validateConfig does not pass them through (no handler in validate.ts or
// validate-ext.ts). So cfgInterval/cfgTimeout/cfgLimit always fall back to
// defaults from D. These tests document that current behavior.

describe("cfgInterval", () => {
  test("always falls back to typed default (intervals not in validator)", () => {
    resetConfig();
    writeConfig({ intervals: { capture: 100 } });
    // intervals stripped by validateConfig → always returns D default
    expect(cfgInterval("capture")).toBe(D.intervals.capture);
  });

  test("returns default for every key", () => {
    resetConfig();
    expect(cfgInterval("capture")).toBe(D.intervals.capture);
    expect(cfgInterval("sessions")).toBe(D.intervals.sessions);
    expect(cfgInterval("peerFetch")).toBe(D.intervals.peerFetch);
  });
});

describe("cfgTimeout", () => {
  test("always falls back to typed default (timeouts not in validator)", () => {
    resetConfig();
    writeConfig({ timeouts: { http: 10000 } });
    expect(cfgTimeout("http")).toBe(D.timeouts.http);
  });

  test("returns default for every key", () => {
    resetConfig();
    expect(cfgTimeout("http")).toBe(D.timeouts.http);
    expect(cfgTimeout("health")).toBe(D.timeouts.health);
    expect(cfgTimeout("wakeRetry")).toBe(D.timeouts.wakeRetry);
  });
});

describe("cfgLimit", () => {
  test("always falls back to typed default (limits not in validator)", () => {
    resetConfig();
    writeConfig({ limits: { feedMax: 1000 } });
    expect(cfgLimit("feedMax")).toBe(D.limits.feedMax);
  });

  test("returns default for every key", () => {
    resetConfig();
    expect(cfgLimit("feedMax")).toBe(D.limits.feedMax);
    expect(cfgLimit("logsMax")).toBe(D.limits.logsMax);
    expect(cfgLimit("ptyCols")).toBe(D.limits.ptyCols);
  });
});

describe("cfg", () => {
  test("returns config value for top-level key", () => {
    resetConfig();
    writeConfig({ host: "custom-host" });
    expect(cfg("host")).toBe("custom-host");
  });

  test("falls back to default for missing key", () => {
    resetConfig();
    removeConfig();
    expect(cfg("host")).toBe("local");
    expect(cfg("port")).toBe(3456);
  });
});
