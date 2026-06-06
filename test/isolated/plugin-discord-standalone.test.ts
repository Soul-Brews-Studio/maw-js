import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const { default: discordHandler } = await import("../../src/vendor/mpr-plugins/discord/index.ts?plugin-discord-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("discord plugin standalone boundary", () => {
  test("uses only SDK/plugin/platform dependencies and plugin-local imports", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/discord/index.ts",
      "src/vendor/mpr-plugins/discord/lib.ts",
      "src/vendor/mpr-plugins/discord/tokens.ts",
      "src/vendor/mpr-plugins/discord/status.ts",
      "src/vendor/mpr-plugins/discord/bind.ts",
      "src/vendor/mpr-plugins/discord/access.ts",
      "src/vendor/mpr-plugins/discord/inventory.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }

    const combined = ["index.ts", "lib.ts", "access.ts", "bind.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/discord", file), "utf8"),
    ).join("\n");
    expect(combined).toContain('from "maw-js/plugin/types"');
    expect(combined).toContain('from "maw-js/sdk"');
  });

  test("prints usage for help forms without touching token or host state", async () => {
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const result = await discordHandler({ source: "cli", args } as any);

      expect(result.ok).toBe(true);
      const output = stripAnsi(result.output);
      expect(output).toContain("usage: maw discord <subcommand> [args]");
      expect(output).toContain("tokens ls");
      expect(output).toContain("status [bot]");
      expect(output).toContain("access <bot>");
    }
  });

  test("prints plugin version and subcommand status", async () => {
    const result = await discordHandler({ source: "cli", args: ["version"] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain("maw discord v");
    expect(output).toContain("subcommand status:");
    expect(output).toContain("tokens ls / check");
    expect(output).toContain("serve (after_send hook)");
  });

  test("routes planned commands to explicit not-implemented failures", async () => {
    for (const sub of ["pair", "route", "serve"]) {
      const result = await discordHandler({ source: "cli", args: [sub] } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe(`${sub} not implemented`);
      expect(stripAnsi(result.output)).toContain(`'${sub}' not implemented yet`);
    }
  });

  test("reports unknown token action and unknown top-level subcommand", async () => {
    const token = await discordHandler({ source: "cli", args: ["tokens", "wat"] } as any);
    expect(token.ok).toBe(false);
    expect(token.error).toBe("unknown action: wat");
    expect(stripAnsi(token.output)).toContain("usage: maw discord tokens <ls|check> [bot]");

    const top = await discordHandler({ source: "cli", args: ["wat"] } as any);
    expect(top.ok).toBe(false);
    expect(top.error).toBe("unknown subcommand: wat");
    expect(stripAnsi(top.output)).toContain("usage: maw discord <subcommand> [args]");
  });
});
