import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBunChild } from "./helpers/run-bun-child";

function runConfigChild(script: string, env: Record<string, string>) {
  return runBunChild({
    script,
    env: {
      ...process.env,
      MAW_TEST_MODE: "1",
      MAW_QUIET: "1",
      ...env,
    },
  });
}

function parseJsonLine(stdout: string, prefix: string): unknown {
  const line = stdout.split("\n").find((entry) => entry.startsWith(prefix));
  expect(line).toBeTruthy();
  return JSON.parse(line!.slice(prefix.length));
}

describe("config load coverage", () => {
  test("loads defaults, caches until reset, and writes sandboxed saves", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-config-load-"));
    try {
      const configDir = join(sandbox, "config");
      const configFile = join(configDir, "maw.config.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configFile, JSON.stringify({
        node: "first-node",
        env: { SHORT: "abc", SECRET: "super-secret-value" },
        federationToken: "abcdefghijklmnop",
      }));

      const script =
        `import{writeFileSync as w}from"fs";` +
        `const{CONFIG_FILE:f}=await import("${process.cwd()}/src/core/paths.ts");` +
        `const{loadConfig:l,resetConfig:r,saveConfig:s}=await import("${process.cwd()}/src/config/load.ts");` +
        `const a=l();w(f,JSON.stringify({node:"second-node"}));const b=l();r();const c=l();` +
        `const d=s({env:{TINY:"xy",TOKEN:"abcdef"},federationToken:"1234567890abcdef",node:"saved-node"});` +
        `console.log("RESULT:"+JSON.stringify({configFile:f,firstNode:a.node,cachedNode:b.node,reloadedNode:c.node,savedNode:d.node}))`;

      const result = runConfigChild(script, { MAW_HOME: sandbox });
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("saveConfig refused");
      const payload = parseJsonLine(result.stdout, "RESULT:") as Record<string, any>;

      expect(payload.configFile).toBe(configFile);
      expect(payload.firstNode).toBe("first-node");
      expect(payload.cachedNode).toBe("first-node");
      expect(payload.reloadedNode).toBe("second-node");
      expect(payload.savedNode).toBe("saved-node");

      const written = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(written.node).toBe("saved-node");
      expect(written.env).toEqual({ TINY: "xy", TOKEN: "abcdef" });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("configForDisplay masks secrets and cfg helpers return defaults", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-config-display-"));
    try {
      const configDir = join(sandbox, "config");
      const configFile = join(configDir, "maw.config.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configFile, JSON.stringify({
        env: { SHORT: "abc", SECRET: "super-secret-value" },
        federationToken: "abcdefghijklmnop",
      }));

      const script = `
        const { configForDisplay, cfg, cfgInterval, cfgTimeout, cfgLimit } =
          await import("${process.cwd()}/src/config/load.ts");
        const display = configForDisplay();
        console.log("RESULT:" + JSON.stringify({
          displayEnv: display.env,
          displayEnvMasked: display.envMasked,
          displayFederationToken: display.federationToken,
          cfgHost: cfg("host"),
          cfgCapture: cfgInterval("capture"),
          cfgHttp: cfgTimeout("http"),
          cfgMessageTruncate: cfgLimit("messageTruncate"),
        }));
      `;

      const result = runConfigChild(script, { MAW_HOME: sandbox });
      expect(result.code).toBe(0);
      const payload = parseJsonLine(result.stdout, "RESULT:") as Record<string, any>;

      expect(payload.displayEnv).toEqual({});
      expect(payload.displayEnvMasked).toEqual({ SHORT: "•••", SECRET: "sup•••••••••••••••" });
      expect(payload.displayFederationToken).toBe("abcd••••••••••••");
      expect(payload.cfgHost).toBe("local");
      expect(payload.cfgCapture).toBe(50);
      expect(payload.cfgHttp).toBe(5000);
      expect(payload.cfgMessageTruncate).toBe(100);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("loadConfig heals host migrations and stale default-active disabled plugin lists", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-config-load-migrate-"));
    try {
      const configDir = join(sandbox, "config");
      const configFile = join(configDir, "maw.config.json");
      mkdirSync(configDir, { recursive: true });
      const staleDisabled = [
        "team", "fleet", "panes", "peers", "pair", "tmux", "kill", "plugin", "doctor", "inbox",
        "split", "shellenv", "completions", "learn", "find", "talk-to", "project", "workon", "cleanup",
        "manual-a", "manual-b", "manual-c", "manual-d", "manual-e",
      ];
      writeFileSync(configFile, JSON.stringify({
        host: "m5",
        node: "m5",
        ghqRoot: "/legacy/ghq",
        disabledPlugins: staleDisabled,
        migrations: {},
      }));

      const script = `
        const { readFileSync } = await import("fs");
        const { CONFIG_FILE } = await import("${process.cwd()}/src/core/paths.ts");
        const { loadConfig } = await import("${process.cwd()}/src/config/load.ts");
        const config = loadConfig();
        const persisted = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        console.log("RESULT:" + JSON.stringify({
          host: config.host,
          bind: config.bind ?? null,
          disabledPlugins: config.disabledPlugins,
          migrations: config.migrations,
          persistedHost: persisted.host,
          persistedDisabledPlugins: persisted.disabledPlugins,
          persistedMigrations: persisted.migrations,
        }));
      `;

      const result = runConfigChild(script, { MAW_HOME: sandbox });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("legacy init bug (#906)");
      expect(result.stderr).toContain("config.disabledPlugins migration (#1500)");
      expect(result.stderr).toContain("config.disabledPlugins migration (#1514)");
      expect(result.stderr).toContain("config.disabledPlugins migration (#1523)");
      expect(result.stderr).toContain("config.disabledPlugins migration (#1524)");
      expect(result.stderr).toContain("config.disabledPlugins migration (#1531)");
      expect(result.stderr).toContain("config.ghqRoot is deprecated");

      const payload = parseJsonLine(result.stdout, "RESULT:") as Record<string, any>;
      expect(payload.host).toBe("local");
      expect(payload.bind).toBeNull();
      expect(payload.disabledPlugins).toEqual(["manual-a", "manual-b", "manual-c", "manual-d", "manual-e"]);
      expect(payload.persistedHost).toBe("local");
      expect(payload.persistedDisabledPlugins).toEqual(payload.disabledPlugins);
      expect(payload.migrations).toEqual({
        defaultActivePlugins1500: true,
        defaultActivePlugins1514: true,
        defaultActivePlugins1523: true,
        defaultActivePlugins1524: true,
        defaultActivePlugins1531: true,
      });
      expect(payload.persistedMigrations).toEqual(payload.migrations);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("loadConfig migrates bind-address hosts without persisting when only in-memory heal is needed", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "maw-config-load-bind-"));
    try {
      const configDir = join(sandbox, "config");
      const configFile = join(configDir, "maw.config.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configFile, JSON.stringify({ host: "0.0.0.0", node: "white" }));

      const script = `
        const { readFileSync } = await import("fs");
        const { CONFIG_FILE } = await import("${process.cwd()}/src/core/paths.ts");
        const { loadConfig } = await import("${process.cwd()}/src/config/load.ts");
        const config = loadConfig();
        const persisted = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        console.log("RESULT:" + JSON.stringify({
          host: config.host,
          bind: config.bind,
          persistedHost: persisted.host,
          persistedBind: persisted.bind ?? null,
        }));
      `;

      const result = runConfigChild(script, { MAW_HOME: sandbox });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("config.host \"0.0.0.0\" is a bind address");
      const payload = parseJsonLine(result.stdout, "RESULT:") as Record<string, any>;
      expect(payload.host).toBe("local");
      expect(payload.bind).toBe("0.0.0.0");
      expect(payload.persistedHost).toBe("0.0.0.0");
      expect(payload.persistedBind).toBeNull();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
