import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let repos: string[] = [];
let logs: string[] = [];
let commands: string[] = [];
let searches: Array<{ query: string; project: string }> = [];
let scenario: "many-active" | "offline-all" | "empty-scan" = "many-active";

const original = {
  cwd: process.cwd(),
  log: console.log,
  fetch: globalThis.fetch,
  dateNow: Date.now,
};

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => fakeHostExec(cmd),
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => {
    if (scenario === "offline-all") {
      return [{ name: "edge", windows: [{ name: "edge", repo: "Soul-Brews-Studio/edge-oracle" }] }];
    }
    if (scenario === "empty-scan") {
      return [{ name: "empty", windows: [{ name: "missing", repo: "Soul-Brews-Studio/missing-oracle" }] }];
    }
    return [{ name: "many", windows: [{ name: "dupe", repo: "Soul-Brews-Studio/repo-00-oracle" }] }];
  },
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?edge-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-edge-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-edge-cwd-"));
  repos = [];
  logs = [];
  commands = [];
  searches = [];
  scenario = "many-active";
  process.chdir(cwd);
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  Date.now = () => new Date("2026-05-18T00:00:00.000Z").getTime();
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  globalThis.fetch = original.fetch;
  Date.now = original.dateNow;
  rmSync(ghqRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("dream command edge branch coverage", () => {
  test("default connected scan queries only the first twelve active repos and dedupes old plans and warnings", async () => {
    repos = Array.from({ length: 13 }, (_, index) => createRepo(`repo-${String(index).padStart(2, "0")}-oracle`));
    writeRecentHandoff(repos[0]!, [
      "| Priority | Item | Context |",
      "| --- | --- | --- |",
      "| Soon | Follow edge table handoff | |",
    ].join("\n"));

    await cmdDream({} as never);

    const searchedProjects = searches
      .filter(({ query }) => query === "what went wrong what error occurred how to fix")
      .map(({ project }) => project);
    expect(searchedProjects).toHaveLength(12);
    expect(searchedProjects).toContain("github.com/Soul-Brews-Studio/repo-11-oracle");
    expect(searchedProjects).not.toContain("github.com/Soul-Brews-Studio/repo-12-oracle");

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Follow edge table handoff");
    expect(output).toContain("Forgotten");
    expect(output.match(/Finish edge dedupe branch coverage/g)?.length).toBe(1);
    expect(output).toContain("Watch Out");
    expect(output.match(/repo-00: Edge warning repeats/g)?.length).toBe(1);
    expect(output).not.toContain("BTC long position repeats");

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: connected");
    expect(dream).toContain("repo-00 — 6 uncommitted files");
    expect(dream).toContain("repo-00 — 1 orphaned worktree(s)");
    expect(dream).toContain("Hotspots: repo-00 (3)");
    expect(dream).toContain("Coverage: 3/3 pains have plans in the same project");
  });

  test("all mode falls back to offline repo cards when health check and scan commands fail", async () => {
    scenario = "offline-all";
    repos = [createRepo("edge-oracle")];

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream");
    expect(output).toContain("● edge");
    expect(output).toContain("0/week");
    expect(output).toContain("📊 1/1 active repos shown");
    expect(output).toContain("saved →");
    expect(readLatestDream()).toContain("**Scanned**: 1 repos | **Oracle KB**: offline");
    expect(commands).toContain("ghq list -p 2>/dev/null");
  });

  test("project lookup reports an empty known list when fleet and ghq scan produce no usable repos", async () => {
    scenario = "empty-scan";
    createRepo("no-psi-oracle", false);

    await cmdDream({ project: "ghost" } as never);

    const output = logs.join("\n");
    expect(output).toContain('project "ghost" not found');
    expect(output).toContain("known: ");
    expect(output).not.toContain("no-psi");
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") {
    if (scenario === "offline-all") throw new Error("ghq unavailable");
    if (scenario === "empty-scan") return `${join(ghqRoot, "github.com", "Soul-Brews-Studio", "no-psi-oracle")}\n`;
    return `${repos.join("\n")}\n`;
  }
  if (cmd.includes("log --oneline --since=")) {
    if (scenario === "offline-all") throw new Error("momentum unavailable");
    return cmd.includes("repo-00-oracle") ? "3" : "1";
  }
  if (cmd.includes("log -1 --format='%s'")) {
    if (cmd.includes("missing-oracle")) throw new Error("missing repo");
    return cmd.includes("repo-00-oracle") ? "Edge active branch" : "Edge quiet branch";
  }
  if (cmd.includes("log -1 --format='%ct'")) {
    if (cmd.includes("missing-oracle")) throw new Error("missing repo");
    return String(Math.floor(new Date("2026-05-17T00:00:00.000Z").getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    if (scenario === "offline-all") throw new Error("status unavailable");
    return cmd.includes("repo-00-oracle") ? " M a\n M b\n M c\n M d\n M e\n M f\n" : "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    if (scenario === "offline-all") throw new Error("worktree unavailable");
    const repoPath = repos.find((repo) => cmd.includes(repo)) ?? repos[0]!;
    return cmd.includes("repo-00-oracle")
      ? `worktree ${repoPath}\n\nworktree ${repoPath}-scratch\n`
      : `worktree ${repoPath}\n`;
  }
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const project = url.searchParams.get("project") ?? "";
  if (scenario === "offline-all") throw new Error("offline edge");
  if (query === "test") return response(true, []);

  searches.push({ query, project });
  return response(true, resultsFor(query, project));
}

function resultsFor(query: string, project: string) {
  if (query.includes("what went wrong")) {
    if (!project.includes("repo-00-oracle")) return [];
    return [
      arra("repo-00-oracle", "# Edge failure needs plan coverage\nSummary:\n- Edge pain remains actionable", "2026-05-17_pain.md", 0.9),
    ];
  }
  if (query.includes("what should we build next")) {
    if (!project.includes("repo-00-oracle")) return [];
    return [arra("repo-00-oracle", "Next Steps:\n- Edge failure needs plan coverage", "2026-05-17_plan.md", 0.8)];
  }
  if (query.includes("next steps should build")) {
    return [
      arra("repo-00-oracle", "Next Steps:\n- Finish edge dedupe branch coverage", "2026-04-25_plan.md", 0.9),
      arra("repo-00-oracle", "Pending:\n- Finish edge dedupe branch coverage with duplicate suffix", "2026-04-24_duplicate.md", 0.8),
      arra("repo-00-oracle", "Next Session:\n- completed edge branch already shipped\n- continue as required", "2026-04-23_done.md", 0.8),
    ];
  }
  if (query.includes("keeps happening same bug")) {
    return [
      arra("repo-00-oracle", "# Edge warning repeats\nSummary:\n- active warning", "2026-05-17_warning.md", 0.9),
      arra("repo-00-oracle", "# Edge warning repeats\nSummary:\n- duplicate warning", "2026-05-17_warning_dup.md", 0.8),
      arra("repo-12-oracle", "# Inactive warning should not show\nSummary:\n- inactive warning", "2026-05-17_inactive.md", 0.8),
      arra("repo-00-oracle", "# BTC long position repeats\nSummary:\n- noisy warning", "2026-05-17_noise.md", 0.8),
    ];
  }
  return [];
}

function createRepo(dirName: string, withPsi = true): string {
  const repoPath = join(ghqRoot, "github.com", "Soul-Brews-Studio", dirName);
  mkdirSync(withPsi ? join(repoPath, "ψ") : repoPath, { recursive: true });
  return repoPath;
}

function writeRecentHandoff(repoPath: string, content: string): void {
  const handoff = join(repoPath, "ψ", "inbox", "handoff", "2026-05-17_edge.md");
  mkdirSync(join(repoPath, "ψ", "inbox", "handoff"), { recursive: true });
  writeFileSync(handoff, content);
  const time = new Date("2026-05-17T00:00:00.000Z");
  utimesSync(handoff, time, time);
}

function arra(repoDir: string, content: string, filename: string, score: number) {
  return {
    content,
    type: "retro",
    source_file: `/vault/${repoDir}/ψ/memory/logs/info/${filename}`,
    score,
  };
}

function response(ok: boolean, results: ReturnType<typeof arra>[]): Response {
  return { ok, json: async () => ({ results }) } as Response;
}

function readLatestDream(): string {
  const dir = join(cwd, "ψ", "writing", "dreams");
  const latest = readdirSync(dir).filter((file) => file.endsWith("_dream.md")).sort().at(-1);
  expect(latest).toBeDefined();
  return readFileSync(join(dir, latest!), "utf-8");
}
