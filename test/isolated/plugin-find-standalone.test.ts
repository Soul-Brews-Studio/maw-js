import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const sandbox = join(import.meta.dir, ".tmp-find-standalone");
const origCwd = process.cwd();
const ghqRoot = join(sandbox, "ghq");
const hostExecCalls: string[] = [];
let fleet: Array<{
  name: string;
  windows: Array<{ name: string; repo?: string }>;
  sync_peers?: string[];
  project_repos?: string[];
}> = [];
let hostResponses: Record<string, string> = {};

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  getGhqRoot: () => ghqRoot,
  loadFleetCore: () => fleet,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostResponses[cmd] ?? "";
  },
}));

const { default: findHandler } = await import("../../src/vendor/mpr-plugins/find/index.ts?plugin-find-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "neo-oracle"), { recursive: true });
  mkdirSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "ghost"), { recursive: true });
  process.chdir(sandbox);
  hostExecCalls.length = 0;
  hostResponses = {};
  fleet = [
    {
      name: "1-neo",
      windows: [{ name: "main", repo: "Soul-Brews-Studio/neo-oracle" }],
      sync_peers: ["white:neo"],
      project_repos: ["Soul-Brews-Studio/maw-js"],
    },
    { name: "2-ghost", windows: [{ name: "quiet", repo: "Soul-Brews-Studio/ghost" }] },
  ];
});

afterEach(() => {
  process.chdir(origCwd);
});

describe("find plugin standalone boundary (#2113)", () => {
  test("imports runtime dependencies from the SDK boundary", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "find" });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
  });

  test("finds oracle and fleet matches with only SDK mocked", async () => {
    const result = await findHandler({ source: "cli", args: ["neo"] } as any);

    expect(result.ok).toBe(true);
    const output = stripAnsi(result.output);
    expect(output).toContain('Searching — "neo"');
    expect(output).toContain("Oracles");
    expect(output).toContain("neo (Soul-Brews-Studio/neo-oracle)");
    expect(output).toContain("Fleet");
    expect(output).toContain("session 1-neo");
    expect(output).toContain("sync_peer white:neo");
  });

  test("searches psi memory via SDK hostExec and supports --oracle filter", async () => {
    const psiPath = join(ghqRoot, "github.com", "Soul-Brews-Studio", "neo-oracle", "ψ", "memory");
    mkdirSync(psiPath, { recursive: true });
    writeFileSync(join(psiPath, "note.md"), "needle appears here\n");
    const findCmd = `grep -ril 'needle' '${psiPath}' 2>/dev/null || true`;
    const matchCmd = `grep -m1 -i 'needle' '${join(psiPath, "note.md")}' 2>/dev/null || true`;
    hostResponses[findCmd] = `${join(psiPath, "note.md")}\n`;
    hostResponses[matchCmd] = "needle appears here\n";

    const result = await findHandler({ source: "cli", args: ["needle", "--oracle", "neo"] } as any);

    expect(result.ok).toBe(true);
    expect(hostExecCalls).toEqual([findCmd, matchCmd]);
    const output = stripAnsi(result.output);
    expect(output).toContain("Code");
    expect(output).toContain("neo (1 match)");
    expect(output).toContain("note.md");
    expect(output).toContain("needle appears here");
  });

  test("returns usage error when keyword is missing", async () => {
    const result = await findHandler({ source: "cli", args: [] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw find <keyword>");
  });
});
