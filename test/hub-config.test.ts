import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpConfigDir = mkdtempSync(join(tmpdir(), "maw-hub-config-test-"));
process.env.MAW_CONFIG_DIR = tmpConfigDir;

const { WORKSPACES_DIR, loadWorkspaceConfigs, validateWorkspaceConfig } = await import("../src/transports/hub-config");

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

  test("warning includes the invalid filename and reason", () => {
    mkdirSync(WORKSPACES_DIR, { recursive: true });
    writeFileSync(join(WORKSPACES_DIR, "bad.json"), JSON.stringify({ id: "ws-bad", hubUrl: "http://hub", token: "t", sharedAgents: [] }));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      expect(loadWorkspaceConfigs()).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).toContain("[hub] invalid workspace config: bad.json (hubUrl must be ws:|wss: (got http:))");
  });
});
