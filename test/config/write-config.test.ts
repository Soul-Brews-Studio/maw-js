/**
 * Tests for src/commands/plugins/init/write-config.ts — buildConfig (pure) +
 * writeConfigAtomic, backupConfig, configExists (fs with parameterized paths).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildConfig,
  writeConfigAtomic,
  backupConfig,
  configExists,
} from "../../src/commands/plugins/init/write-config";

describe("buildConfig", () => {
  it("includes host, node, port, ghqRoot defaults", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/home/boom/ghq" });
    expect(cfg.host).toBe("mba");
    expect(cfg.node).toBe("mba");
    expect(cfg.port).toBe(3456);
    expect(cfg.ghqRoot).toBe("/home/boom/ghq");
  });

  it("sets oracleUrl default", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq" });
    expect(cfg.oracleUrl).toBe("http://localhost:47779");
  });

  it("sets default command", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq" });
    expect(cfg.commands).toEqual({ default: "claude --dangerously-skip-permissions --continue" });
  });

  it("includes token in env when provided", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq", token: "abc123" });
    expect(cfg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("abc123");
  });

  it("env is empty object when no token", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq" });
    expect(cfg.env).toEqual({});
  });

  it("includes federation fields when federate is true", () => {
    const peers = [{ name: "kc", url: "http://kc:3456" }];
    const cfg = buildConfig({
      node: "mba",
      ghqRoot: "/ghq",
      federate: true,
      peers,
      federationToken: "fed-token",
    });
    expect(cfg.federationToken).toBe("fed-token");
    expect(cfg.namedPeers).toEqual(peers);
  });

  it("omits federation fields when federate is false", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq", federate: false });
    expect(cfg.federationToken).toBeUndefined();
    expect(cfg.namedPeers).toBeUndefined();
  });

  it("defaults peers to empty array when federate but no peers", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq", federate: true });
    expect(cfg.namedPeers).toEqual([]);
  });

  it("includes sessions as empty object", () => {
    const cfg = buildConfig({ node: "mba", ghqRoot: "/ghq" });
    expect(cfg.sessions).toEqual({});
  });
});

describe("writeConfigAtomic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-write-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes JSON file with trailing newline", () => {
    const filePath = join(tmp, "maw.config.json");
    writeConfigAtomic(filePath, { host: "test" } as any, true);
    const content = readFileSync(filePath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content).host).toBe("test");
  });

  it("creates parent directories", () => {
    const filePath = join(tmp, "deep", "nested", "maw.config.json");
    writeConfigAtomic(filePath, { host: "test" } as any, true);
    expect(existsSync(filePath)).toBe(true);
  });

  it("overwrites existing file when overwrite=true", () => {
    const filePath = join(tmp, "maw.config.json");
    writeConfigAtomic(filePath, { host: "first" } as any, true);
    writeConfigAtomic(filePath, { host: "second" } as any, true);
    expect(JSON.parse(readFileSync(filePath, "utf-8")).host).toBe("second");
  });

  it("throws when overwrite=false and file exists", () => {
    const filePath = join(tmp, "maw.config.json");
    writeConfigAtomic(filePath, { host: "first" } as any, false);
    expect(() => writeConfigAtomic(filePath, { host: "second" } as any, false)).toThrow();
  });

  it("succeeds with overwrite=false on new file", () => {
    const filePath = join(tmp, "new.json");
    writeConfigAtomic(filePath, { host: "new" } as any, false);
    expect(JSON.parse(readFileSync(filePath, "utf-8")).host).toBe("new");
  });

  it("pretty-prints with 2-space indent", () => {
    const filePath = join(tmp, "pretty.json");
    writeConfigAtomic(filePath, { host: "test", port: 3456 } as any, true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('  "host"');
  });
});

describe("backupConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates backup file with .bak. prefix", () => {
    const filePath = join(tmp, "maw.config.json");
    writeFileSync(filePath, '{"host":"original"}');
    const bakPath = backupConfig(filePath);
    expect(bakPath).toContain(".bak.");
    expect(existsSync(bakPath)).toBe(true);
  });

  it("backup contains same content as original", () => {
    const filePath = join(tmp, "maw.config.json");
    writeFileSync(filePath, '{"host":"original"}');
    const bakPath = backupConfig(filePath);
    expect(readFileSync(bakPath, "utf-8")).toBe('{"host":"original"}');
  });

  it("backup path includes timestamp", () => {
    const filePath = join(tmp, "maw.config.json");
    writeFileSync(filePath, "test");
    const bakPath = backupConfig(filePath);
    // Timestamp format: 2026-04-27T12-00-00-000Z
    expect(bakPath).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}T/);
  });
});

describe("configExists", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-exists-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for existing file", () => {
    const filePath = join(tmp, "exists.json");
    writeFileSync(filePath, "{}");
    expect(configExists(filePath)).toBe(true);
  });

  it("returns false for non-existent file", () => {
    expect(configExists(join(tmp, "nope.json"))).toBe(false);
  });
});
