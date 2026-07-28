import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBunChild } from "./helpers/run-bun-child";

function run(script: string, cwd: string, env: Record<string, string>) {
  return runBunChild({
    cwd,
    script,
    env: { MAW_TEST_MODE: "1", MAW_QUIET: "1", ...env },
  });
}

function jsonLine(stdout: string) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT:"));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice("RESULT:".length));
}

describe("cwd-aware local config layers", () => {
  test("loadConfig and buildCommandInDir use cwd-specific project layers", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-local-config-"));
    try {
      const mawHome = join(sandbox, "home");
      const repoA = join(sandbox, "repo-a");
      const repoB = join(sandbox, "repo-b");
      mkdirSync(join(mawHome, "config"), { recursive: true });
      mkdirSync(join(repoA, ".maw"), { recursive: true });
      mkdirSync(join(repoB, ".maw"), { recursive: true });
      writeFileSync(join(mawHome, "config", "maw.config.50.json"), JSON.stringify({
        commands: { default: "global-engine" },
        env: { GLOBAL: "1" },
      }));
      writeFileSync(join(repoA, ".maw", "maw.config.80.json"), JSON.stringify({
        commands: { default: "repo-a-engine" },
        env: { PROJECT: "a" },
      }));
      writeFileSync(join(repoB, ".maw", "maw.config.80.json"), JSON.stringify({
        commands: { default: "repo-b-engine" },
        env: { PROJECT: "b" },
      }));

      const result = run(`
        const { loadConfig, buildCommandInDir } = await import("${process.cwd()}/src/config.ts");
        const a = loadConfig({ cwd: ${JSON.stringify(repoA)} });
        const b = loadConfig({ cwd: ${JSON.stringify(repoB)} });
        console.log("RESULT:" + JSON.stringify({
          aDefault: a.commands.default,
          bDefault: b.commands.default,
          aEnv: a.env,
          cmdA: buildCommandInDir("worker", ${JSON.stringify(repoA)}),
          cmdB: buildCommandInDir("worker", ${JSON.stringify(repoB)}),
        }));
      `, repoA, { MAW_HOME: mawHome });

      expect(result.code).toBe(0);
      const payload = jsonLine(result.stdout);
      expect(payload.aDefault).toBe("repo-a-engine");
      expect(payload.bDefault).toBe("repo-b-engine");
      expect(payload.aEnv).toEqual({ GLOBAL: "1", PROJECT: "a" });
      expect(payload.cmdA).toBe("repo-a-engine");
      expect(payload.cmdB).toBe("repo-b-engine");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("arrays replace, null deletes, provenance records null delete source, and restricted project keys warn", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-local-config-provenance-"));
    try {
      const mawHome = join(sandbox, "home");
      const repo = join(sandbox, "repo");
      mkdirSync(join(mawHome, "config"), { recursive: true });
      mkdirSync(join(repo, ".maw"), { recursive: true });
      writeFileSync(join(mawHome, "config", "maw.config.50.json"), JSON.stringify({
        commands: { default: "global", extra: "keep" },
        peers: ["https://global.example"],
        env: { KEEP: "1", DROP: "1" },
      }));
      writeFileSync(join(repo, ".maw", "maw.config.80.json"), JSON.stringify({
        commands: { default: "project" },
        peers: ["https://project.example"],
        port: 4567,
        env: { DROP: null },
      }));

      const result = run(`
        const { loadConfigWithProvenance } = await import("${process.cwd()}/src/config.ts");
        const loaded = loadConfigWithProvenance({ cwd: ${JSON.stringify(repo)} });
        console.log("RESULT:" + JSON.stringify({
          config: loaded.config,
          warnings: loaded.warnings,
          drop: loaded.provenance["env.DROP"],
          peers: loaded.provenance.peers,
        }));
      `, repo, { MAW_HOME: mawHome });

      expect(result.code).toBe(0);
      const payload = jsonLine(result.stdout);
      expect(payload.config.commands).toEqual({ default: "project", extra: "keep" });
      expect(payload.config.peers).toEqual(["https://project.example"]);
      expect(payload.config.env).toEqual({ KEEP: "1" });
      expect(payload.warnings.join("\n")).toContain('restricted key "port"');
      expect(payload.warnings.join("\n")).toContain('restricted key "peers"');
      expect(payload.drop.at(-1).action).toBe("delete");
      expect(payload.peers.at(-1).value).toEqual(["https://project.example"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
