import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
let tempDir = "";
let fleetDir = "";
let ghqRoot = "";
let hostExecCalls: string[] = [];
let fleetEntries: Array<{
  file: string;
  path?: string;
  num: number;
  groupName: string;
  session: { name: string; windows: Array<{ name: string; repo?: string }>; sync_peers?: string[]; project_repos?: string[] };
}> = [];
let fleetSessions: Array<{ name: string; windows: Array<{ name: string; repo?: string }>; sync_peers?: string[]; project_repos?: string[] }> = [];
let ghqFindResult: string | null = null;

const sdkMock = {
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "";
  },
  getGhqRoot: () => ghqRoot,
  fleetLoadDirForWrite: () => fleetDir,
  loadFleetEntries: () => fleetEntries,
  loadFleetCore: () => fleetSessions,
  ghqFind: async () => ghqFindResult,
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const { default: archiveHandler, command } = await import("../../src/vendor/mpr-plugins/archive/index.ts?plugin-archive-standalone");
const { cmdArchive } = await import("../../src/vendor/mpr-plugins/archive/impl.ts?plugin-archive-standalone");
const { resolveOraclePath, resolveProjectSlug } = await import("../../src/vendor/mpr-plugins/archive/internal/soul-sync-impl.ts?plugin-archive-standalone");

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

beforeEach(() => {
  (globalThis as any).__archiveStandaloneActive = true;
  tempDir = mkdtempSync(join(tmpdir(), "maw-archive-standalone-"));
  fleetDir = join(tempDir, "fleet");
  ghqRoot = join(tempDir, "ghq");
  mkdirSync(fleetDir, { recursive: true });
  mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "neo-oracle"), { recursive: true });
  hostExecCalls = [];
  ghqFindResult = null;
  fleetEntries = [{
    file: "01-neo.json",
    path: join(fleetDir, "01-neo.json"),
    num: 1,
    groupName: "neo",
    session: {
      name: "01-neo",
      windows: [{ name: "neo-oracle", repo: "Soul-Brews-Studio/neo-oracle" }],
      sync_peers: ["m5"],
      project_repos: ["Soul-Brews-Studio/maw-js"],
    },
  }];
  fleetSessions = fleetEntries.map((entry) => entry.session);
  writeFileSync(join(fleetDir, "01-neo.json"), JSON.stringify(fleetEntries[0].session), "utf8");
});

afterEach(() => {
  delete (globalThis as any).__archiveStandaloneActive;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("archive plugin standalone boundary", () => {
  test("imports runtime helpers only through the SDK boundary", () => {
    const pluginDir = join(root, "src/vendor/mpr-plugins/archive");
    const sources = walkSources(pluginDir).map((file) => readFileSync(file, "utf8")).join("\n");

    expect(command).toMatchObject({ name: "archive" });
    expect(sources).toContain('from "maw-js/sdk"');
    expect(sources).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(sources).not.toMatch(/from\s+["'](?:\.\.\/)+(?:core|commands|cli|config|lib|src)\//);
  });

  test("dry-run archives by reading fleet entries through SDK without side effects", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await cmdArchive("neo", { dryRun: true });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Archiving");
    expect(output).toContain("[dry-run] would soul-sync to m5");
    expect(output).toContain("[dry-run] would disable: 01-neo.json → 01-neo.json.disabled");
    expect(output).toContain("[dry-run] would archive: gh repo archive Soul-Brews-Studio/neo-oracle");
    expect(hostExecCalls).toEqual([]);
    expect(existsSync(join(fleetDir, "01-neo.json"))).toBe(true);
  });

  test("non-dry archive disables fleet config and archives repo", async () => {
    fleetEntries[0].session.sync_peers = [];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await cmdArchive("neo");
    } finally {
      console.log = origLog;
    }

    expect(hostExecCalls).toEqual(["gh repo archive Soul-Brews-Studio/neo-oracle --yes"]);
    expect(existsSync(join(fleetDir, "01-neo.json"))).toBe(false);
    expect(existsSync(join(fleetDir, "01-neo.json.disabled"))).toBe(true);
    const output = logs.join("\n");
    expect(output).toContain("fleet config disabled: 01-neo.json.disabled");
    expect(output).toContain("GitHub repo archived: Soul-Brews-Studio/neo-oracle");
  });

  test("usage and missing fleet entries stay user-facing errors", async () => {
    const usage = await archiveHandler({ source: "cli", args: [] } as any);
    expect(usage.ok).toBe(false);
    expect(usage.error).toContain("usage: maw archive <oracle> [--dry-run]");

    await expect(cmdArchive("ghost")).rejects.toThrow("oracle 'ghost' not found in fleet config");
  });

  test("soul-sync resolution helpers use SDK ghq, ghq root, and fleet loaders", async () => {
    ghqFindResult = join(ghqRoot, "github.com", "Soul-Brews-Studio", "neo-oracle");
    await expect(resolveOraclePath("neo")).resolves.toBe(ghqFindResult);

    ghqFindResult = null;
    await expect(resolveOraclePath("neo-oracle")).resolves.toBe(join(ghqRoot, "github.com", "Soul-Brews-Studio", "neo-oracle"));

    expect(resolveProjectSlug(join(ghqRoot, "github.com", "Soul-Brews-Studio", "maw-js", "agents", "1-codex"), ghqRoot)).toBe("Soul-Brews-Studio/maw-js");
  });
});
