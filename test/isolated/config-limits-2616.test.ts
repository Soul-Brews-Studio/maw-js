/** @maw-test-isolate */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function parseResult(stdout: string): Record<string, any> {
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice("RESULT:".length));
}

describe("config limits in MAW_HOME sessions (#2616)", () => {
  test("inherits singleton limits for config explain, cfgLimit, and wake-concurrency source", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-config-limits-2616-"));
    try {
      const xdgConfigHome = join(sandbox, "xdg-config");
      const singletonConfigDir = join(xdgConfigHome, "maw");
      const singletonConfigFile = join(singletonConfigDir, "maw.config.50.json");
      mkdirSync(singletonConfigDir, { recursive: true });
      writeFileSync(singletonConfigFile, JSON.stringify({
        limits: { maxConcurrentAgents: 20 },
      }, null, 2));

      const mawHome = join(sandbox, "instance");
      const scriptFile = join(sandbox, "repro-2616.ts");
      writeFileSync(scriptFile, `
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const config = await import("${process.cwd()}/src/config/load.ts");
        const wake = await import("${process.cwd()}/src/commands/shared/wake-concurrency.ts");
        const plugin = (await import("${process.cwd()}/src/commands/plugins/config/index.ts")).default;

        const firstLoaded = config.loadConfigWithProvenance();
        const explainLogs = [];
        const explain = await plugin({
          source: "cli",
          args: ["explain", "limits.maxConcurrentAgents", "--json"],
          writer: (...args) => explainLogs.push(args.map(String).join(" ")),
        });
        const firstLimit = config.cfgLimit("maxConcurrentAgents");
        const firstSourceLine = wake.maxConcurrentAgentsSourceLine();

        mkdirSync(join(process.env.MAW_HOME, "config"), { recursive: true });
        writeFileSync(join(process.env.MAW_HOME, "config", "maw.config.90.local.json"), JSON.stringify({
          limits: { maxConcurrentAgents: 30 },
        }, null, 2));
        config.resetConfig();
        const secondLoaded = config.loadConfigWithProvenance();

        console.log("RESULT:" + JSON.stringify({
          firstLimit,
          firstConfigLimit: firstLoaded.config.limits?.maxConcurrentAgents,
          firstSource: firstLoaded.provenance["limits.maxConcurrentAgents"]?.at(-1)?.path,
          explainOk: explain.ok,
          explain: JSON.parse(explainLogs.join("\\n")),
          sourceLine: firstSourceLine,
          secondLimit: secondLoaded.config.limits?.maxConcurrentAgents,
          secondSource: secondLoaded.provenance["limits.maxConcurrentAgents"]?.at(-1)?.path,
        }));
      `);

      const result = spawnSync(process.execPath, [scriptFile], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: sandbox,
          XDG_CONFIG_HOME: xdgConfigHome,
          MAW_HOME: mawHome,
          MAW_CONFIG_DIR: "",
          MAW_TEST_MODE: "",
          MAW_QUIET: "1",
        },
      });

      if (result.status !== 0) console.error(result.stderr || result.stdout);
      expect(result.status).toBe(0);
      const payload = parseResult(result.stdout);
      expect(payload.firstLimit).toBe(20);
      expect(payload.firstConfigLimit).toBe(20);
      expect(payload.firstSource).toBe(singletonConfigFile);
      expect(payload.explainOk).toBe(true);
      expect(payload.explain.finalValue).toBe(20);
      expect(payload.explain.entries.at(-1)).toMatchObject({
        path: singletonConfigFile,
        value: 20,
        action: "set",
      });
      expect(payload.sourceLine).toBe(`limits.maxConcurrentAgents: 20 from ${singletonConfigFile}`);
      expect(payload.secondLimit).toBe(30);
      expect(payload.secondSource).toBe(join(mawHome, "config", "maw.config.90.local.json"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
