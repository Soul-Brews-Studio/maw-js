/**
 * #820 — Guard test: `saveConfig` MUST refuse to write to the real homedir
 * when MAW_TEST_MODE=1. Catches the regression where a test fixture
 * (mba.example, /tmp/nope, node:"white") leaked into the developer's real
 * ~/.config/maw/maw.config.json mid-session.
 *
 * Implementation note: src/core/paths.ts evaluates CONFIG_DIR at import time,
 * which means a single bun process can't toggle MAW_HOME between two tests
 * (the first import freezes the path). We therefore drive each scenario in a
 * fresh subprocess so paths.ts is re-evaluated under the right env.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";

function runScript(script: string, env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("#820 saveConfig guard — refuse to corrupt real homedir in test mode", () => {
  test("MAW_TEST_MODE=1 + CONFIG_FILE at real homedir → saveConfig throws", () => {
    const realPath = join(homedir(), ".config", "maw", "maw.config.json");
    const before = existsSync(realPath) ? readFileSync(realPath, "utf-8") : null;

    // Unset MAW_HOME / MAW_CONFIG_DIR so paths.ts resolves real homedir.
    const script = `
      delete process.env.MAW_HOME;
      delete process.env.MAW_CONFIG_DIR;
      const { saveConfig } = await import("${process.cwd()}/src/config/load.ts");
      try {
        saveConfig({ node: "leak-canary" });
        console.log("UNEXPECTED_OK");
      } catch (e) {
        console.log("THREW:" + (e instanceof Error ? e.message : String(e)));
      }
    `;
    const { stdout } = runScript(script, { MAW_TEST_MODE: "1", MAW_HOME: "", MAW_CONFIG_DIR: "" });

    expect(stdout).toContain("THREW:");
    expect(stdout).toContain("MAW_TEST_MODE");
    expect(stdout).not.toContain("UNEXPECTED_OK");

    // Defense-in-depth: real file must not have changed.
    const after = existsSync(realPath) ? readFileSync(realPath, "utf-8") : null;
    expect(after).toBe(before);
  });

  test("MAW_TEST_MODE=1 + MAW_HOME=<tmpdir> → saveConfig succeeds (guard not over-broad)", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-save-guard-"));

    const script = `
      const { saveConfig } = await import("${process.cwd()}/src/config/load.ts");
      const { CONFIG_FILE } = await import("${process.cwd()}/src/core/paths.ts");
      console.log("CONFIG_FILE:" + CONFIG_FILE);
      try {
        saveConfig({ node: "sandbox-ok" });
        console.log("OK");
      } catch (e) {
        console.log("THREW:" + (e instanceof Error ? e.message : String(e)));
      }
    `;
    const { stdout } = runScript(script, { MAW_TEST_MODE: "1", MAW_HOME: sandbox });

    expect(stdout).toContain(`CONFIG_FILE:${sandbox}`);
    expect(stdout).toContain("OK");
    expect(stdout).not.toContain("THREW:");

    // Verify it wrote to the sandbox.
    const sandboxFile = join(sandbox, "config", "maw.config.json");
    expect(existsSync(sandboxFile)).toBe(true);
    const written = JSON.parse(readFileSync(sandboxFile, "utf-8"));
    expect(written.node).toBe("sandbox-ok");
  });
});
