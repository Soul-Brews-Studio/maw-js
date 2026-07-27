import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { requireOracleIdentity, resolveOracleIdentity } from "../src/core/identity";

const ENV_KEYS = [
  "MAW_IDENTITY",
  "MAW_FROM",
  "MAW_AGENT_NAME",
  "ORACLE_NAME",
  "CLAUDE_AGENT_NAME",
  "AGENT_NAME",
  "TMUX",
] as const;

let originalCwd = "";
let tempRoot = "";
let originalEnv: Record<string, string | undefined> = {};

describe("oracle identity resolution", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempRoot = mkdtempSync(join(tmpdir(), "maw-identity-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("uses explicit sender env outside tmux", () => {
    process.env.MAW_FROM = "mac-mini:hermes";
    expect(requireOracleIdentity()).toEqual({ name: "hermes", source: "env" });
  });

  test("derives background-job identity from oracle repo cwd without tmux", () => {
    const oracleDir = join(tempRoot, "oracles", "hermes");
    mkdirSync(oracleDir, { recursive: true });
    process.chdir(oracleDir);
    expect(requireOracleIdentity()).toEqual({ name: "hermes", source: "cwd" });
  });

  test("does not query tmux when TMUX is absent", () => {
    process.chdir(tempRoot);
    expect(resolveOracleIdentity()).toBeNull();
  });
});
