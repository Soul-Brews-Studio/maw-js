import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-hub-config-test-"));
process.env.MAW_CONFIG_DIR = join(tmpRoot, "config");
process.env.MAW_DATA_DIR = join(tmpRoot, "data");

const { WORKSPACES_DIR, loadWorkspaceConfigs, validateWorkspaceConfig } = await import("../../src/vendor/mpr-plugins/hub/hub-config");

describe("hub workspace config validation (#1521)", () => {
  test("returns actionable reasons for invalid fields", () => {
    expect(validateWorkspaceConfig(null)).toEqual({ ok: false, reason: "not an object" });
    expect(validateWorkspaceConfig({ hubUrl: "ws://hub", token: "t", sharedAgents: [] })).toEqual({ ok: false, reason: "missing/empty id" });
    expect(validateWorkspaceConfig({ id: "ws", token: "t", sharedAgents: [] })).toEqual({ ok: false, reason: "missing/empty hubUrl" });
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "ws://hub", sharedAgents: [] })).toEqual({ ok: false, reason: "missing/empty token" });
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "ws://hub", token: "t" })).toEqual({ ok: false, reason: "sharedAgents must be array" });
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "http://hub", token: "t", sharedAgents: [] })).toEqual({ ok: false, reason: "hubUrl must be ws:|wss: (got http:)" });
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "not a url", token: "t", sharedAgents: [] })).toEqual({ ok: false, reason: "hubUrl not a valid URL" });
  });

  test("accepts ws/wss configs", () => {
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "ws://hub", token: "t", sharedAgents: [] })).toEqual({ ok: true });
    expect(validateWorkspaceConfig({ id: "ws", hubUrl: "wss://hub", token: "t", sharedAgents: ["agent"] })).toEqual({ ok: true });
  });

  test("skips invalid workspace configs silently by default", () => {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "bad.json"), JSON.stringify({ id: "ws-bad", hubUrl: "http://hub", token: "t", sharedAgents: [] }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalFlag = process.env.MAW_HUB_CONFIG_WARNINGS;
    delete process.env.MAW_HUB_CONFIG_WARNINGS;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(loadWorkspaceConfigs()).toEqual([]);
    } finally {
      console.warn = originalWarn;
      if (originalFlag === undefined) delete process.env.MAW_HUB_CONFIG_WARNINGS;
      else process.env.MAW_HUB_CONFIG_WARNINGS = originalFlag;
    }
    expect(warnings).toEqual([]);
  });

  test("opt-in diagnostics include the invalid filename and reason", () => {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "bad.json"), JSON.stringify({ id: "ws-bad", hubUrl: "http://hub", token: "t", sharedAgents: [] }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalFlag = process.env.MAW_HUB_CONFIG_WARNINGS;
    process.env.MAW_HUB_CONFIG_WARNINGS = "1";
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(loadWorkspaceConfigs()).toEqual([]);
    } finally {
      console.warn = originalWarn;
      if (originalFlag === undefined) delete process.env.MAW_HUB_CONFIG_WARNINGS;
      else process.env.MAW_HUB_CONFIG_WARNINGS = originalFlag;
    }
    expect(warnings.join("\n")).toContain("[hub] invalid workspace config: bad.json (hubUrl must be ws:|wss: (got http:))");
  });

  test("loads workspace configs from data before legacy config fallback", () => {
    const legacyDir = join(process.env.MAW_CONFIG_DIR!, "workspaces");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(WORKSPACES_DIR, { recursive: true });

    writeFileSync(join(legacyDir, "legacy.json"), JSON.stringify({
      id: "legacy",
      hubUrl: "wss://legacy.example.test",
      token: "legacy-token",
      sharedAgents: ["legacy"],
    }));
    writeFileSync(join(legacyDir, "shared.json"), JSON.stringify({
      id: "shared",
      hubUrl: "wss://legacy-shared.example.test",
      token: "legacy-shared-token",
      sharedAgents: ["legacy"],
    }));
    writeFileSync(join(WORKSPACES_DIR, "shared.json"), JSON.stringify({
      id: "shared",
      hubUrl: "wss://data-shared.example.test",
      token: "data-shared-token",
      sharedAgents: ["data"],
    }));

    expect(loadWorkspaceConfigs()).toEqual([
      { id: "legacy", hubUrl: "wss://legacy.example.test", token: "legacy-token", sharedAgents: ["legacy"] },
      { id: "shared", hubUrl: "wss://data-shared.example.test", token: "data-shared-token", sharedAgents: ["data"] },
    ]);
  });
});
