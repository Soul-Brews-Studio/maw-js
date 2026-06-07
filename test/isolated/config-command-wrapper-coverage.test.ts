import { describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

mock.module(join(srcRoot, "src/config/load"), () => ({
  loadConfig: () => ({
    commands: {
      default: "claude",
      codex: "codex --search",
    },
    env: { ALPHA: "1", BETA: "two" },
  }),
}));

const { buildCommand, buildCommandInDir, getEnvVars } = await import("../../src/config/command.ts?wrapper-coverage");

describe("config command wrapper coverage", () => {
  test("buildCommand, buildCommandInDir, and getEnvVars delegate through loadConfig", () => {
    expect(buildCommand("mawjs-oracle", "codex")).toBe("codex --search");
    expect(buildCommandInDir("mawjs-oracle", "/tmp/repo", "codex")).toBe("codex --search");
    expect(getEnvVars()).toEqual({ ALPHA: "1", BETA: "two" });
  });
});
