import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

let repos: string[] = [];
let sessions: Array<{ name: string; windows: Array<{ index: number; name: string }> }> = [];
let fleetEntries: any[] = [];
let captures: Record<string, string | Error> = {};
let worktrees: Array<{ name: string; path: string }> = [];
let detectedSession: string | null = null;

class UserError extends Error {}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  ghqFind: async (pattern: string) => repos.find((repo) => new RegExp(pattern).test(repo)) ?? null,
  ghqList: async () => repos,
  listSessions: async () => sessions,
  loadFleetEntries: () => fleetEntries,
  detectSession: async () => detectedSession,
  findWorktrees: async () => worktrees,
  capture: async (target: string) => {
    const result = captures[target];
    if (result instanceof Error) throw result;
    return result ?? "";
  },
  UserError,
}));

const { default: aboutHandler } = await import("../../src/vendor/mpr-plugins/about/index.ts?plugin-about-standalone");
const helpers = await import("../../src/vendor/mpr-plugins/about/internal/impl-helpers.ts?plugin-about-standalone");

beforeEach(() => {
  repos = ["/ghq/github.com/Soul-Brews-Studio/mawjs-oracle"];
  sessions = [{ name: "139-mawjs", windows: [{ index: 1, name: "mawjs-oracle" }, { index: 2, name: "scratch" }] }];
  fleetEntries = [{
    file: "139-mawjs.json",
    session: { windows: [{ name: "mawjs-oracle" }] },
  }];
  captures = { "139-mawjs:1": "ready", "139-mawjs:2": "" };
  worktrees = [{ name: "agent-1", path: "/ghq/github.com/Soul-Brews-Studio/mawjs-oracle/agents/1" }];
  detectedSession = "139-mawjs";
});

describe("about plugin standalone boundary (#2113)", () => {
  test("imports runtime dependencies through SDK and plugin-local helpers only", () => {
    for (const rel of ["index.ts", "internal/impl-about.ts", "internal/impl-helpers.ts"]) {
      const source = readFileSync(join(root, "src/vendor/mpr-plugins/about", rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    }
    const combined = ["index.ts", "internal/impl-about.ts", "internal/impl-helpers.ts"]
      .map((rel) => readFileSync(join(root, "src/vendor/mpr-plugins/about", rel), "utf8"))
      .join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain('from "./impl-helpers"');
  });

  test("handler renders repo, session, worktree, fleet, and unregistered window details", async () => {
    const result = await aboutHandler({ source: "cli", args: ["mawjs"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Oracle — mawjs");
    expect(result.output).toContain("Repo:      /ghq/github.com/Soul-Brews-Studio/mawjs-oracle");
    expect(result.output).toContain("Session:   139-mawjs (2 windows)");
    expect(result.output).toContain("mawjs-oracle");
    expect(result.output).toContain("scratch");
    expect(result.output).toContain("Worktrees: 1");
    expect(result.output).toContain("agent-1 → /ghq/github.com/Soul-Brews-Studio/mawjs-oracle/agents/1");
    expect(result.output).toContain("Fleet:     139-mawjs.json (1 registered, 2 running)");
    expect(result.output).toContain("scratch");
  });

  test("API validation and not-found errors stay structured", async () => {
    const missingArg = await aboutHandler({ source: "cli", args: [] } as any);
    expect(missingArg).toEqual({ ok: false, error: "usage: maw about <oracle>" });

    const missingApi = await aboutHandler({ source: "api", args: {} } as any);
    expect(missingApi).toEqual({ ok: false, error: "oracle is required" });

    repos = [];
    sessions = [];
    fleetEntries = [];
    detectedSession = null;
    const notFound = await aboutHandler({ source: "api", args: { oracle: "ghost" } } as any);
    expect(notFound.ok).toBe(false);
    expect(notFound.error).toContain("no oracle named 'ghost'");
  });

  test("resolver handles owner/repo, ambiguous oracle names, direct names, and discovery helpers", async () => {
    expect(await helpers.resolveOracleSafe("Soul-Brews-Studio/mawjs-oracle")).toMatchObject({
      repoName: "mawjs-oracle",
      repoPath: "/ghq/github.com/Soul-Brews-Studio/mawjs-oracle",
      parentDir: "/ghq/github.com/Soul-Brews-Studio",
    });

    repos = [
      "/ghq/github.com/A/dup-oracle",
      "/ghq/github.com/B/dup-oracle",
    ];
    await expect(helpers.resolveOracleSafe("dup")).rejects.toThrow("ambiguous oracle short-name 'dup'");

    repos = ["/ghq/github.com/Soul-Brews-Studio/plain"];
    expect(await helpers.resolveOracleSafe("plain")).toMatchObject({ repoName: "plain" });

    fleetEntries = [{ session: { windows: [{ name: "fleet-oracle" }] } }];
    sessions = [{ name: "live", windows: [{ index: 1, name: "live-oracle" }] }];
    expect(await helpers.discoverOracles()).toEqual(["fleet", "live"]);

    expect(helpers.lineageOf({ name: "fleet", has_fleet_config: true, has_psi: false, federation_node: "node-a" }, true, {})).toMatchObject({
      hasFleetConfig: true,
      isAwake: true,
      federationNode: "node-a",
    });
  });
});
