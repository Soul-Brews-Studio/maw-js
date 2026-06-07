import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { OracleManifestEntry } from "maw-js/lib/oracle-manifest";
import type { GitStat, OracleEntryLite } from "../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

let roots: string[] = [];
let promptAnswers: string[] = [];
let promptQuestions: string[] = [];
let promptCloses = 0;
let originalTestMode: string | undefined;

mock.module("readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      promptQuestions.push(q);
      return promptAnswers.shift() ?? "no";
    },
    close: () => {
      promptCloses++;
    },
  }),
}));

const {
  cmdPruneStale,
  findPruneCandidates,
} = await import("../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles.ts?cleanup-prune-stale-oracles-next-coverage");

beforeEach(() => {
  originalTestMode = process.env.MAW_TEST_MODE;
  promptAnswers = [];
  promptQuestions = [];
  promptCloses = 0;
});

afterEach(() => {
  if (originalTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalTestMode;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-prune-next-"));
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

function stat(daysOld: number, sizeKb = 64) {
  return { mtimeMs: NOW - daysOld * DAY_MS, sizeBytes: sizeKb * 1024 };
}

function cleanGit(patch: Partial<GitStat> = {}): GitStat {
  return {
    isClean: true,
    unpushed: 0,
    uncommitted: 0,
    totalCommits: 1,
    detached: false,
    ...patch,
  };
}

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("cleanup prune stale oracles next coverage", () => {
  test("cmdPruneStale --ask uses the default readline prompt and closes it", async () => {
    const dir = tempDir();
    const file = join(dir, "oracles.json");
    writeFileSync(file, JSON.stringify({ oracles: [entry("ask-default")] }, null, 2));
    promptAnswers = [" YES "];

    const output = await captureLogs(() =>
      cmdPruneStale({
        ask: true,
        cacheFile: file,
        env: {
          manifest: [manifest("ask-default")],
          cwd: "/elsewhere",
          now: NOW,
          statDir: () => stat(1),
          checkGit: async () => cleanGit(),
        },
      }),
    );

    expect(promptQuestions).toHaveLength(1);
    expect(promptQuestions[0]).toContain("Prune ask-default");
    expect(promptCloses).toBe(1);
    expect(output).toContain("Pruning 1 entry");
    expect(JSON.parse(readFileSync(file, "utf-8")).oracles).toEqual([]);
  });

  test("cmdPruneStale --yes runs the abort countdown outside MAW_TEST_MODE without waiting", async () => {
    const dir = tempDir();
    const file = join(dir, "oracles.json");
    writeFileSync(file, JSON.stringify({ oracles: [entry("safe-missing")] }, null, 2));

    delete process.env.MAW_TEST_MODE;
    const originalSleep = Bun.sleep;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const sleeps: number[] = [];
    const writes: string[] = [];
    (Bun as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const output = await captureLogs(() =>
        cmdPruneStale({
          yes: true,
          cacheFile: file,
          env: {
            manifest: [manifest("safe-missing")],
            cwd: "/elsewhere",
            statDir: () => null,
          },
        }),
      );
      expect(output).toContain("Pruning in 3s");
      expect(output).toContain("wrote oracles.json (0 entries remain, 1 pruned)");
    } finally {
      (Bun as unknown as { sleep: typeof originalSleep }).sleep = originalSleep;
      (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    }

    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(writes.join("")).toContain("3...");
    expect(writes.join("")).toContain("2...");
    expect(writes.join("")).toContain("1...");
  });

  test("default git probe catches spawn failures while preserving a safe empty-repo classification", async () => {
    const dir = tempDir();
    const clone = join(dir, "clone");
    const cwd = join(dir, "operator");
    mkdirSync(clone);
    mkdirSync(cwd);

    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      throw new Error("spawn unavailable");
    }) as typeof Bun.spawn;
    let survey;
    try {
      survey = await findPruneCandidates({
        cacheEntries: [entry("spawn-throws", clone)],
        manifest: [manifest("spawn-throws")],
        cwd,
      });
    } finally {
      (Bun as unknown as { spawn: typeof originalSpawn }).spawn = originalSpawn;
    }

    expect(survey.safe).toHaveLength(1);
    expect(survey.safe[0].entry.name).toBe("spawn-throws");
    expect(survey.safe[0].git).toMatchObject({
      isClean: true,
      unpushed: 0,
      uncommitted: 0,
      totalCommits: 0,
      detached: true,
    });
  });

  test("default git probe handles clean status, missing upstream, detached HEAD, and invalid commit counts", async () => {
    const dir = tempDir();
    const clone = join(dir, "clone-clean");
    const cwd = join(dir, "operator-clean");
    mkdirSync(clone);
    mkdirSync(cwd);

    const originalSpawn = Bun.spawn;
    const spawnCalls: string[] = [];
    const proc = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      exitCode,
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((args: string[]) => {
      const gitArgs = args.slice(3).join(" ");
      spawnCalls.push(gitArgs);
      if (gitArgs === "status --porcelain") return proc("");
      if (gitArgs === "rev-parse --abbrev-ref @{u}") return proc("", 1);
      if (gitArgs === "symbolic-ref -q HEAD") return proc("", 1);
      if (gitArgs === "rev-list --all --count") return proc("not-a-number\n");
      return proc("", 1);
    }) as typeof Bun.spawn;
    let survey;
    try {
      survey = await findPruneCandidates({
        cacheEntries: [entry("clean-detached", clone)],
        manifest: [manifest("clean-detached")],
        cwd,
      });
    } finally {
      (Bun as unknown as { spawn: typeof originalSpawn }).spawn = originalSpawn;
    }

    expect(survey.safe).toHaveLength(1);
    expect(survey.safe[0].reason).toMatch(/^empty, \d+K$/);
    expect(survey.safe[0].git).toMatchObject({
      isClean: true,
      unpushed: 0,
      uncommitted: 0,
      totalCommits: 0,
      detached: true,
    });
    expect(spawnCalls).toEqual([
      "status --porcelain",
      "rev-parse --abbrev-ref @{u}",
      "symbolic-ref -q HEAD",
      "rev-list --all --count",
    ]);
  });
});
