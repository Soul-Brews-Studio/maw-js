import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const pluginRoot = join(root, "src/vendor/mpr-plugins/shellenv");
const { default: shellenvHandler } = await import("../../src/vendor/mpr-plugins/shellenv/src/index.ts?plugin-shellenv-standalone");
const { SUPPORTED_SHELLS } = await import("../../src/vendor/mpr-plugins/shellenv/src/impl.ts?plugin-shellenv-standalone");
const { parseFlags } = await import("../../src/vendor/mpr-plugins/shellenv/src/internal/parse-flags.ts?plugin-shellenv-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("shellenv plugin standalone boundary (#2113)", () => {
  test("has no direct maw-js core/shared/lib/plugin imports", () => {
    const files = [
      "src/index.ts",
      "src/impl.ts",
      "src/internal/parse-flags.ts",
      "src/internal/user-error.ts",
      "src/snippets/bash.ts",
      "src/snippets/zsh.ts",
    ];

    for (const file of files) {
      const source = readFileSync(join(pluginRoot, file), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|plugin)(?:\/|\")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+\.\.\//);
    }
  });

  test("emits zsh and bash snippets without host dependencies", async () => {
    expect(SUPPORTED_SHELLS).toEqual(["zsh", "bash"]);

    const zsh = await shellenvHandler({ source: "cli", args: ["zsh"] } as any);
    expect(zsh.ok).toBe(true);
    expect(zsh.output).toContain("maw shellenv (zsh)");
    expect(zsh.output).toContain("command maw locate");
    expect(zsh.output).toContain("claude46()");

    const bash = await shellenvHandler({ source: "cli", args: ["bash"] } as any);
    expect(bash.ok).toBe(true);
    expect(bash.output).toContain("maw shellenv (bash)");
    expect(bash.output).toContain("builtin cd");
  });

  test("handles help, missing shell, unsupported shell, and local flag parsing", async () => {
    expect(parseFlags(["-h", "zsh"], { "--help": Boolean, "-h": "--help" }, 0)).toEqual({
      _: ["zsh"],
      "--help": true,
    });

    const help = await shellenvHandler({ source: "cli", args: ["--help"] } as any);
    expect(help.ok).toBe(true);
    expect(help.output).toContain("usage: maw shellenv <shell>");

    const missing = await shellenvHandler({ source: "cli", args: [] } as any);
    expect(missing.ok).toBe(false);
    expect(stripAnsi(missing.error)).toContain("shell '' not supported");
    expect(missing.exitCode).toBe(1);

    const fish = await shellenvHandler({ source: "cli", args: ["fish"] } as any);
    expect(fish.ok).toBe(false);
    expect(stripAnsi(fish.error)).toContain("shell 'fish' not supported");
  });
});
