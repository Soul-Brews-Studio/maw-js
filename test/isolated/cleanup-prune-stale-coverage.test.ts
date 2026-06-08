import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OracleManifestEntry } from "maw-js/lib/oracle-manifest";
import {
  bucketEntry,
  cmdPruneStale,
  findPruneCandidates,
  readOraclesCache,
  type DirStat,
  type GitStat,
  type OracleEntryLite,
} from "../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-prune-coverage-"));
  tempRoots.push(dir);
  return dir;
}

function entry(name: string, overrides: Partial<OracleEntryLite> = {}): OracleEntryLite {
  return {
    org: "Soul-Brews-Studio",
    repo: `${name}-repo`,
    name,
    local_path: `/tmp/${name}`,
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function manifest(name: string, sources: OracleManifestEntry["sources"] = ["oracles-json"]): OracleManifestEntry {
  return {
    name,
    sources,
    repo: `Soul-Brews-Studio/${name}-repo`,
    localPath: `/tmp/${name}`,
    isLive: sources.includes("fleet") || sources.includes("session") || sources.includes("agent"),
  };
}

function stat(daysOld: number, sizeKb = 64): DirStat {
  return { mtimeMs: NOW - daysOld * DAY_MS, sizeBytes: sizeKb * 1024 };
}

function git(overrides: Partial<GitStat> = {}): GitStat {
  return {
    isClean: true,
    unpushed: 0,
    uncommitted: 0,
    totalCommits: 3,
    detached: false,
    ...overrides,
  };
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  try {
    await fn();
    return logs;
  } finally {
    console.log = originalLog;
  }
}

describe("cleanup prune stale coverage", () => {
  test("bucketEntry classifies missing, dirty, empty, old, recent, placeholder, and middle-aged clones", () => {
    const e = entry("candidate");

    expect(bucketEntry(e, null, null, NOW)).toEqual({
      bucket: "safe",
      reason: "clone missing",
      cloneMissing: true,
    });

    expect(bucketEntry(e, stat(40), null, NOW)).toEqual({
      bucket: "never-touch",
      reason: "git inspect failed",
      cloneMissing: false,
    });

    expect(bucketEntry(e, stat(40), git({ uncommitted: 2 }), NOW)).toMatchObject({
      bucket: "never-touch",
      reason: "2 uncommitted",
    });

    expect(bucketEntry(e, stat(40), git({ unpushed: 1 }), NOW).reason).toBe("1 unpushed commit");
    expect(bucketEntry(e, stat(40), git({ detached: true }), NOW).reason).toBe("detached HEAD");

    expect(bucketEntry(e, stat(1), git({ totalCommits: 0 }), NOW)).toMatchObject({
      bucket: "safe",
      reason: "empty, 64K",
    });

    expect(bucketEntry(e, stat(45), git(), NOW)).toMatchObject({
      bucket: "safe",
      reason: "clean, 45d old, 64K",
    });

    expect(bucketEntry(e, stat(2), git(), NOW)).toMatchObject({
      bucket: "ask-first",
      reason: "recent, modified 2026-05-16",
    });

    expect(bucketEntry(e, stat(20, 126), git(), NOW)).toMatchObject({
      bucket: "ask-first",
      reason: "126K, modified 2026-04-28",
    });

    expect(bucketEntry(e, stat(14), git(), NOW)).toMatchObject({
      bucket: "ask-first",
      reason: "14d old, 64K",
    });
  });

  test("findPruneCandidates filters non-stale, ψ, and cwd entries before probing candidates", async () => {
    const entries = [
      entry("live"),
      entry("vault", { has_psi: true }),
      entry("self", { local_path: "/work/self" }),
      entry("missing", { local_path: "/work/missing" }),
      entry("dirty", { local_path: "/work/dirty" }),
      entry("recent", { local_path: "/work/recent" }),
      entry("git-fail", { local_path: "/work/git-fail" }),
    ];
    const statCalls: string[] = [];
    const gitCalls: string[] = [];

    const survey = await findPruneCandidates({
      cacheEntries: entries,
      manifest: [
        manifest("live", ["oracles-json", "fleet"]),
        manifest("vault"),
        manifest("self"),
        manifest("missing"),
        manifest("dirty"),
        manifest("recent"),
        manifest("git-fail"),
      ],
      cwd: "/work/self/subdir",
      now: NOW,
      statDir: (path) => {
        statCalls.push(path);
        if (path.endsWith("missing")) return null;
        if (path.endsWith("recent")) return stat(1);
        return stat(40);
      },
      checkGit: async (path) => {
        gitCalls.push(path);
        if (path.endsWith("dirty")) return git({ uncommitted: 1 });
        if (path.endsWith("git-fail")) throw new Error("git exploded");
        return git();
      },
    });

    expect(survey.totalEntries).toBe(7);
    expect(survey.totalStale).toBe(6);
    expect(survey.withPsi).toBe(1);
    expect(survey.safe.map((c) => c.entry.name)).toEqual(["missing"]);
    expect(survey.askFirst.map((c) => c.entry.name)).toEqual(["recent"]);
    expect(survey.neverTouch.map((c) => c.entry.name)).toEqual(["dirty", "git-fail"]);
    expect(survey.neverTouch.find((c) => c.entry.name === "git-fail")?.reason).toBe("git inspect failed");
    expect(statCalls.sort()).toEqual(["/work/dirty", "/work/git-fail", "/work/missing", "/work/recent"]);
    expect(gitCalls.sort()).toEqual(["/work/dirty", "/work/git-fail", "/work/recent"]);
  });

  test("cmdPruneStale --yes removes only safe entries and preserves unknown cache keys", async () => {
    const dir = tempDir();
    const cacheFile = join(dir, "oracles.json");
    const entries = [
      entry("safe-missing", { local_path: "/work/safe-missing" }),
      entry("ask-recent", { local_path: "/work/ask-recent" }),
      entry("dirty", { local_path: "/work/dirty" }),
      entry("vault", { has_psi: true, local_path: "/work/vault" }),
      entry("live", { local_path: "/work/live" }),
    ];
    writeFileSync(cacheFile, JSON.stringify({ schema: 1, note: "keep me", oracles: entries }, null, 2));

    const logs = await captureLogs(() => cmdPruneStale({
      yes: true,
      cacheFile,
      env: {
        manifest: [
          manifest("safe-missing"),
          manifest("ask-recent"),
          manifest("dirty"),
          manifest("vault"),
          manifest("live", ["oracles-json", "session"]),
        ],
        cwd: "/elsewhere",
        now: NOW,
        statDir: (path) => path.endsWith("safe-missing") ? null : stat(path.endsWith("ask-recent") ? 1 : 40),
        checkGit: async (path) => path.endsWith("dirty") ? git({ unpushed: 2 }) : git(),
      },
    }));

    const written = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(written.schema).toBe(1);
    expect(written.note).toBe("keep me");
    expect(written.oracles.map((e: OracleEntryLite) => e.name)).toEqual(["ask-recent", "dirty", "vault", "live"]);
    expect(logs.join("\n")).toContain("Pruning 1 entry");
    expect(logs.join("\n")).toContain("wrote oracles.json (4 entries remain, 1 pruned)");
  });

  test("cmdPruneStale --ask prunes only affirmative ASK-FIRST answers", async () => {
    const dir = tempDir();
    const cacheFile = join(dir, "oracles.json");
    const entries = [
      entry("ask-yes", { local_path: "/work/ask-yes" }),
      entry("ask-no", { local_path: "/work/ask-no" }),
      entry("safe-old", { local_path: "/work/safe-old" }),
    ];
    writeFileSync(cacheFile, JSON.stringify({ oracles: entries }, null, 2));

    const prompts: string[] = [];
    await captureLogs(() => cmdPruneStale({
      ask: true,
      cacheFile,
      prompt: async (q) => {
        prompts.push(q);
        return q.includes("ask-yes") ? "yes" : "n";
      },
      env: {
        manifest: [manifest("ask-yes"), manifest("ask-no"), manifest("safe-old")],
        cwd: "/elsewhere",
        now: NOW,
        statDir: (path) => path.endsWith("safe-old") ? stat(45) : stat(1),
        checkGit: async () => git(),
      },
    }));

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("ask-yes");
    expect(prompts[1]).toContain("ask-no");
    const written = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(written.oracles.map((e: OracleEntryLite) => e.name)).toEqual(["ask-no", "safe-old"]);
  });

  test("readOraclesCache handles missing, malformed, and missing-oracles cache files", () => {
    const dir = tempDir();
    expect(readOraclesCache(join(dir, "missing.json"))).toBeNull();

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json");
    expect(readOraclesCache(malformed)).toBeNull();

    const noOracles = join(dir, "no-oracles.json");
    writeFileSync(noOracles, JSON.stringify({ schema: 1 }));
    expect(readOraclesCache(noOracles)).toEqual({ raw: { schema: 1 }, entries: [] });
  });
});
