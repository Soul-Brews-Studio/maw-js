import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

type SpawnResult = { stdout?: string; stderr?: string; status?: number; error?: Error };

const root = join(import.meta.dir, "../..");
const spawnCalls: Array<{ command: string; args: string[]; opts?: Record<string, unknown> }> = [];
let spawnResults: Record<string, SpawnResult> = {};

mock.module("child_process", () => ({
  spawnSync: (command: string, args: string[], opts?: Record<string, unknown>) => {
    spawnCalls.push({ command, args, opts });
    const key = `${command} ${args.join(" ")}`;
    const result = spawnResults[key] ?? { stdout: `${command} 1.2.3\n`, status: 0 };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
      error: result.error,
    };
  },
}));

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  tlink: (url: string) => `<${url}>`,
}));

const { default: checkHandler } = await import("../../src/vendor/mpr-plugins/check/index.ts?plugin-check-standalone");
const { checkTool } = await import("../../src/vendor/mpr-plugins/check/impl.ts?plugin-check-standalone");

beforeEach(() => {
  spawnCalls.length = 0;
  spawnResults = {};
});

describe("check plugin standalone boundary (#2226)", () => {
  test("uses only SDK plus platform dependencies, with no core/shared/lib imports", () => {
    for (const rel of ["index.ts", "impl.ts"]) {
      const source = readFileSync(join(root, "src/vendor/mpr-plugins/check", rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config|plugin)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/check/impl.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
    expect(impl).toContain("tlink");
  });

  test("checks tool versions without host imports", () => {
    spawnResults["tmux -V"] = { stdout: "tmux 3.4\n", status: 0 };
    spawnResults["git --version"] = { stdout: "git version 2.51.0\n", status: 0 };
    spawnResults["which uvx"] = { stdout: "/usr/bin/uvx\n", status: 0 };
    spawnResults["uv --version"] = { stderr: "uv 0.7.2\n", status: 0 };

    expect(checkTool("tmux")).toEqual({ present: true, version: "3.4" });
    expect(checkTool("git")).toEqual({ present: true, version: "2.51.0" });
    expect(checkTool("uvx")).toEqual({ present: true, version: "0.7.2" });
  });

  test("handler renders missing install links through SDK tlink", async () => {
    for (const tool of ["bun", "gh", "ghq", "git", "tmux", "uv"]) {
      spawnResults[`${tool} ${tool === "tmux" ? "-V" : "--version"}`] = { stdout: `${tool} 9.8.7\n`, status: 0 };
    }
    spawnResults["which uvx"] = { status: 1 };

    const result = await checkHandler({ source: "cli", args: ["tools"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw check tools");
    expect(result.output).toContain("5 required");
    expect(result.output).toContain("1 optional");
    expect(result.output).toContain("1 missing");
    expect(result.output).toContain("<https://docs.astral.sh/uv/>");
  });
});
