import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBunChild } from "./helpers/run-bun-child";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "maw-plugin-ls-sort-"));
  homes.push(home);
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "maw.config.json"), JSON.stringify({
    host: "local",
    port: 3456,
    oracleUrl: "http://localhost:47779",
    env: {},
    commands: { default: "claude" },
    sessions: {},
  }) + "\n");
  return home;
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("plugin ls", () => {
  test("sorts each tier alphabetically by plugin name", () => {
    const home = makeHome();
    const script = `
      const { doLs } = await import("${REPO_ROOT}/src/commands/shared/plugins-ls-info.ts");
      const plugin = (name, tier) => ({
        kind: "ts",
        dir: "/tmp/" + name,
        entryPath: "/tmp/" + name + "/index.ts",
        manifest: {
          name,
          version: "1.0.0",
          sdk: "^1.0.0",
          tier,
          entry: "./index.ts",
          cli: { command: name },
        },
      });
      doLs(false, true, () => [
        plugin("zeta", "core"),
        plugin("alpha", "core"),
        plugin("beta", "standard"),
        plugin("aardvark", "standard"),
      ], undefined, { verbose: true });
    `;

    const result = runBunChild({
      script,
      cwd: REPO_ROOT,
      env: { ...process.env, MAW_HOME: home, MAW_TEST_MODE: "1", MAW_QUIET: "1" },
    });

    expect(result.code).toBe(0);
    expect(result.stdout.indexOf("alpha")).toBeLessThan(result.stdout.indexOf("zeta"));
    expect(result.stdout.indexOf("aardvark")).toBeLessThan(result.stdout.indexOf("beta"));
  });
});
