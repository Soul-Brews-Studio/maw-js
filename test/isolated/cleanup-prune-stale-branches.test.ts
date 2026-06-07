import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { OracleManifestEntry } from "maw-js/lib/oracle-manifest";
import {
  cmdPruneStale,
  findPruneCandidates,
  isCwdSelfExclude,
  isStaleByManifest,
  legacyOraclesCachePath,
  oraclesCachePath,
  readOraclesCache,
  writeOraclesCache,
  type OracleEntryLite,
} from "../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-prune-branches-"));
  roots.push(dir);
  return dir;
}

function entry(name: string, localPath = `/tmp/${name}`, overrides: Partial<OracleEntryLite> = {}): OracleEntryLite {
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-repo`,
    name,
    local_path: localPath,
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(name: string, sources: OracleManifestEntry["sources"]): OracleManifestEntry {
  return {
    name,
    sources,
    repo: `Soul-Brews-Studio/${name}-repo`,
    localPath: `/tmp/${name}`,
    isLive: sources.some((s) => s === "fleet" || s === "session" || s === "agent"),
  };
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("cleanup prune stale branch coverage", () => {
  test("manifest stale checks and cwd self-exclusion cover live-source and path edge cases", () => {
    expect(isStaleByManifest(manifest("stale", ["oracles-json"]))).toBe(true);
    expect(isStaleByManifest(manifest("fleet", ["oracles-json", "fleet"]))).toBe(false);
    expect(isStaleByManifest(manifest("session", ["oracles-json", "session"]))).toBe(false);
    expect(isStaleByManifest(manifest("agent", ["oracles-json", "agent"]))).toBe(false);
    expect(isStaleByManifest(manifest("not-cache", ["fleet"]))).toBe(false);

    expect(isCwdSelfExclude("", "/work/repo")).toBe(false);
    expect(isCwdSelfExclude("/work/repo/", "/work/repo")).toBe(true);
    expect(isCwdSelfExclude("/work/repo", "/work/repo/subdir")).toBe(true);
    expect(isCwdSelfExclude("/work/repo/subdir", "/work/repo")).toBe(true);
    expect(isCwdSelfExclude("/work/repo-a", "/work/repo-b")).toBe(false);
  });

  test("cache writer preserves unknown top-level keys while replacing only oracles", () => {
    const dir = tempDir();
    const file = join(dir, "oracles.json");
    writeFileSync(file, JSON.stringify({ schema: 2, owner: "keep", oracles: [entry("old")] }, null, 2));

    const cache = readOraclesCache(file);
    expect(cache?.entries.map((e) => e.name)).toEqual(["old"]);
    writeOraclesCache({ raw: cache!.raw, entries: [entry("new")] }, file);

    const written = JSON.parse(readFileSync(file, "utf-8"));
    expect(written).toMatchObject({ schema: 2, owner: "keep" });
    expect(written.oracles.map((e: OracleEntryLite) => e.name)).toEqual(["new"]);
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
  });


  test("default cache I/O writes cache path and reads legacy config fallback", () => {
    const dir = tempDir();
    const envKeys = ["MAW_HOME", "MAW_CACHE_DIR", "MAW_CONFIG_DIR", "MAW_XDG"] as const;
    const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      delete process.env.MAW_HOME;
      delete process.env.MAW_XDG;
      process.env.MAW_CACHE_DIR = join(dir, "cache");
      process.env.MAW_CONFIG_DIR = join(dir, "legacy-config");

      const primary = oraclesCachePath();
      const legacy = legacyOraclesCachePath();
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, JSON.stringify({ schema: 1, source: "legacy", oracles: [entry("legacy")] }, null, 2));

      expect(primary).toBe(join(dir, "cache", "oracles.json"));
      expect(legacy).toBe(join(dir, "legacy-config", "oracles.json"));
      expect(readOraclesCache()?.entries.map((e) => e.name)).toEqual(["legacy"]);

      writeOraclesCache({ raw: { schema: 1, source: "primary" }, entries: [entry("primary")] });

      const written = JSON.parse(readFileSync(primary, "utf-8"));
      expect(written).toMatchObject({ schema: 1, source: "primary" });
      expect(written.oracles.map((e: OracleEntryLite) => e.name)).toEqual(["primary"]);
      expect(readOraclesCache()?.entries.map((e) => e.name)).toEqual(["primary"]);
    } finally {
      for (const key of envKeys) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("cmdPruneStale preview paths report missing cache, nothing-to-prune, and yes/ask hints", async () => {
    const dir = tempDir();
    const missing = await captureLogs(() => cmdPruneStale({ cacheFile: join(dir, "missing.json") }));
    expect(missing).toContain("No oracles.json found");

    const liveOnly = join(dir, "live-only.json");
    writeFileSync(liveOnly, JSON.stringify({ oracles: [entry("live")] }, null, 2));
    const none = await captureLogs(() => cmdPruneStale({
      cacheFile: liveOnly,
      env: {
        manifest: [manifest("live", ["oracles-json", "fleet"])],
        cwd: "/elsewhere",
      },
    }));
    expect(none).toContain("Stale candidates");
    expect(none).toContain("Nothing to prune.");

    const previewFile = join(dir, "preview.json");
    const safePath = join(dir, "missing-clone");
    const askPath = join(dir, "ask-clone");
    writeFileSync(previewFile, JSON.stringify({
      oracles: [entry("safe", safePath), entry("ask", askPath)],
    }, null, 2));
    const preview = await captureLogs(() => cmdPruneStale({
      cacheFile: previewFile,
      env: {
        manifest: [manifest("safe", ["oracles-json"]), manifest("ask", ["oracles-json"])],
        cwd: "/elsewhere",
        now: Date.UTC(2026, 4, 18),
        statDir: (path) => path === safePath
          ? null
          : { mtimeMs: Date.UTC(2026, 4, 17), sizeBytes: 64 * 1024 },
        checkGit: async () => ({
          isClean: true,
          unpushed: 0,
          uncommitted: 0,
          totalCommits: 1,
          detached: false,
        }),
      },
    }));
    expect(preview).toContain("SAFE TO PRUNE");
    expect(preview).toContain("ASK-FIRST");
    expect(preview).toContain("Run with --yes to prune 1 SAFE entry");
    expect(preview).toContain("Run with --ask to interactively decide on ASK-FIRST.");
  });

  test("cmdPruneStale --ask leaves cache untouched and reports when every answer declines", async () => {
    const dir = tempDir();
    const file = join(dir, "ask-none.json");
    writeFileSync(file, JSON.stringify({ oracles: [entry("ask-one"), entry("ask-two")] }, null, 2));

    const prompts: string[] = [];
    const output = await captureLogs(() => cmdPruneStale({
      ask: true,
      cacheFile: file,
      prompt: async (question) => {
        prompts.push(question);
        return "no";
      },
      env: {
        manifest: [manifest("ask-one", ["oracles-json"]), manifest("ask-two", ["oracles-json"])],
        cwd: "/elsewhere",
        now: Date.UTC(2026, 4, 18),
        statDir: () => ({ mtimeMs: Date.UTC(2026, 4, 17), sizeBytes: 64 * 1024 }),
        checkGit: async () => ({
          isClean: true,
          unpushed: 0,
          uncommitted: 0,
          totalCommits: 1,
          detached: false,
        }),
      },
    }));

    expect(prompts.map((p) => p.match(/Prune ([^(]+)/)?.[1]?.trim())).toEqual(["ask-one", "ask-two"]);
    expect(output).toContain("Nothing selected for pruning.");
    expect(JSON.parse(readFileSync(file, "utf-8")).oracles.map((e: OracleEntryLite) => e.name)).toEqual([
      "ask-one",
      "ask-two",
    ]);
  });

  test("findPruneCandidates can use the default filesystem and git probes for a real non-git directory", async () => {
    const dir = tempDir();
    const clone = join(dir, "real-clone");
    const cwd = join(dir, "operator-elsewhere");
    mkdirSync(clone);
    mkdirSync(cwd);
    writeFileSync(join(clone, "README.md"), "not a git repo\n");

    const survey = await findPruneCandidates({
      cacheEntries: [entry("real", clone)],
      manifest: [manifest("real", ["oracles-json"])],
      cwd,
    });

    expect(survey.safe).toHaveLength(1);
    expect(survey.safe[0].entry.name).toBe("real");
    expect(survey.safe[0].reason).toMatch(/^empty, \d+K$/);
    expect(survey.safe[0].stat?.sizeBytes).toBeGreaterThanOrEqual(0);
    expect(survey.safe[0].git).toMatchObject({
      isClean: true,
      unpushed: 0,
      uncommitted: 0,
      totalCommits: 0,
      detached: true,
    });
  });

  test("findPruneCandidates default probes parse git upstream, ahead, dirty, and missing clone states", async () => {
    const dir = tempDir();
    const clone = join(dir, "clone");
    const cwd = join(dir, "operator");
    mkdirSync(cwd);
    mkdirSync(clone);
    writeFileSync(join(clone, "README.md"), "one\n");

    const missingClone = join(dir, "missing");
    const originalSpawn = Bun.spawn;
    const spawnCalls: string[][] = [];
    const proc = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      exitCode,
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((args: string[]) => {
      spawnCalls.push(args);
      const gitArgs = args.slice(3).join(" ");
      if (gitArgs === "status --porcelain") return proc(" M README.md\n");
      if (gitArgs === "rev-parse --abbrev-ref @{u}") return proc("origin/main\n");
      if (gitArgs === "rev-list --count @{u}..HEAD") return proc("2\n");
      if (gitArgs === "symbolic-ref -q HEAD") return proc("refs/heads/main\n");
      if (gitArgs === "rev-list --all --count") return proc("7\n");
      return proc("", 1);
    }) as typeof Bun.spawn;
    let survey;
    try {
      survey = await findPruneCandidates({
        cacheEntries: [entry("ahead-dirty", clone), entry("missing-default", missingClone)],
        manifest: [
          manifest("ahead-dirty", ["oracles-json"]),
          manifest("missing-default", ["oracles-json"]),
        ],
        cwd,
      });
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }

    expect(survey.neverTouch).toHaveLength(1);
    expect(survey.neverTouch[0].entry.name).toBe("ahead-dirty");
    expect(survey.neverTouch[0].reason).toBe("2 unpushed commits, 1 uncommitted");
    expect(survey.neverTouch[0].git).toMatchObject({
      isClean: false,
      unpushed: 2,
      uncommitted: 1,
      totalCommits: 7,
      detached: false,
    });
    expect(survey.safe.map((c) => [c.entry.name, c.cloneMissing, c.reason])).toEqual([
      ["missing-default", true, "clone missing"],
    ]);
    expect(spawnCalls.map((args) => args.slice(3).join(" "))).toEqual([
      "status --porcelain",
      "rev-parse --abbrev-ref @{u}",
      "rev-list --count @{u}..HEAD",
      "symbolic-ref -q HEAD",
      "rev-list --all --count",
    ]);
  });
});
