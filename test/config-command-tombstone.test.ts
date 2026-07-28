import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBunChild } from "./isolated/helpers/run-bun-child";

function run(script: string, cwd: string, env: Record<string, string>) {
  return runBunChild({
    cwd,
    script,
    env: { MAW_TEST_MODE: "1", MAW_QUIET: "1", ...env },
  });
}

function resultJson(stdout: string) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice("RESULT:".length));
}

describe("command null tombstones (#2674)", () => {
  test("project commands.foo:null deletes a user-layer commands.foo value", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-command-tombstone-"));
    try {
      const mawHome = join(sandbox, "home");
      const repo = join(sandbox, "repo");
      mkdirSync(join(mawHome, "config"), { recursive: true });
      mkdirSync(join(repo, ".maw"), { recursive: true });
      writeFileSync(join(mawHome, "config", "maw.config.50.json"), JSON.stringify({
        commands: { default: "claude", foo: "bar" },
      }));
      writeFileSync(join(repo, ".maw", "maw.config.80.json"), JSON.stringify({
        commands: { foo: null },
      }));

      const result = run(`
        const { loadConfigWithProvenance } = await import(${JSON.stringify(`${process.cwd()}/src/config.ts`)});
        const loaded = loadConfigWithProvenance({ cwd: ${JSON.stringify(repo)} });
        console.log("RESULT:" + JSON.stringify({
          commands: loaded.config.commands,
          fooProvenance: loaded.provenance["commands.foo"],
        }));
      `, repo, { MAW_HOME: mawHome });

      expect(result.code).toBe(0);
      const payload = resultJson(result.stdout);
      expect(payload.commands).toEqual({ default: "claude" });
      expect(payload.fooProvenance.at(-1).action).toBe("delete");
      expect(payload.fooProvenance.at(-1).value).toBeNull();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("null command values emit no string-type warning", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-command-null-warning-"));
    try {
      const mawHome = join(sandbox, "home");
      const repo = join(sandbox, "repo");
      mkdirSync(join(mawHome, "config"), { recursive: true });
      mkdirSync(join(repo, ".maw"), { recursive: true });
      writeFileSync(join(mawHome, "config", "maw.config.50.json"), JSON.stringify({
        commands: { default: "claude", foo: "bar" },
      }));
      writeFileSync(join(repo, ".maw", "maw.config.80.json"), JSON.stringify({
        commands: { foo: null },
      }));

      const result = run(`
        const { loadConfig } = await import(${JSON.stringify(`${process.cwd()}/src/config.ts`)});
        loadConfig({ cwd: ${JSON.stringify(repo)} });
        console.log("RESULT:" + JSON.stringify({ ok: true }));
      `, repo, { MAW_HOME: mawHome });

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("commands.foo must be a string");
      expect(result.stderr).not.toContain("commands.foo must be a string or null");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("non-string non-null command values still warn and are stripped", () => {
    const mawHome = mkdtempSync(join(tmpdir(), "maw-command-invalid-"));
    try {
      const result = run(`
        const { validateConfig } = await import(${JSON.stringify(`${process.cwd()}/src/config/validate-ext.ts`)});
        const validated = validateConfig({
          commands: { default: "run", num: 1, obj: {}, arr: [] },
        });
        console.log("RESULT:" + JSON.stringify({ commands: validated.commands }));
      `, process.cwd(), { MAW_HOME: mawHome });

      expect(result.code).toBe(0);
      expect(resultJson(result.stdout).commands).toEqual({ default: "run" });
      expect(result.stderr).toContain("commands.num must be a string or null");
      expect(result.stderr).toContain("commands.obj must be a string or null");
      expect(result.stderr).toContain("commands.arr must be a string or null");
    } finally {
      rmSync(mawHome, { recursive: true, force: true });
    }
  });
});
