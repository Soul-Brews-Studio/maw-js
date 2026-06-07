import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

let ghqRoot = "";
let cwd = "";
let repos: string[] = [];
let logs: string[] = [];
let commands: string[] = [];
let searchQueries: string[] = [];
let scenario: "connections" | "between" | "speculate" = "connections";

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
  loadFleet: () => [
    {
      name: "base-command-session",
      windows: [
        { name: "alpha", repo: "Soul-Brews-Studio/alpha-oracle" },
        { name: "beta", repo: "Soul-Brews-Studio/beta-oracle" },
      ],
    },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-base-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-base-cwd-"));
  repos = [createRepo("alpha-oracle"), createRepo("beta-oracle"), createRepo("lost-oracle")];
  logs = [];
  commands = [];
  searchQueries = [];
  scenario = "connections";
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

describe("dream command base-module coverage", () => {
  test("project deep dive renders executable connection branches and saves artifacts", async () => {
    scenario = "connections";

    await cmdDream({ project: "alpha" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: alpha");
    expect(output).toContain("Connections");
    expect(output).toContain("has fix planned");
    expect(output).toContain("could prevent");
    expect(output).toContain("Recent commits");
    expect(output).toContain("aaa111 2026-05-17 Base connection commit");
    expect(output).toContain("Open issues");
    expect(output).toContain("#11 Base connection issue");
    expect(output).toContain("Open PRs");
    expect(output).toContain("#12 Base connection PR");
    expect(searchQueries).toContain("pattern appeared again root cause lesson insight");

    const projectDream = readProjectDream("alpha");
    expect(projectDream).toContain("## PAIN — blocking or broken");
    expect(projectDream).toContain("Alpha retry timeout breaks exports");
    expect(projectDream).toContain("## Recent Commits");
    expect(projectDream).toContain("## Open Issues");
    expect(projectDream).toContain("## Open PRs");
  });

  test("between mode writes speculation exports with active repos, plans, risks, warnings, and insights", async () => {
    scenario = "between";
    writeRecentHandoff(repos[0]!, "| Priority | Item | Context |\n| --- | --- | --- |\n| Verify | Verify base command handoff | Keep render branch covered |\n");

    await cmdDream({ between: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Verify base command handoff");
    expect(output).toContain("speculations →");

    const dream = readLatestDream();
    expect(dream).toContain("## Forgotten (planned but never done)");
    expect(dream).toContain("Finish base command forgotten export branch");
    expect(dream).toContain("## Warnings");
    expect(dream).toContain("alpha: Base command warning repeats");
    expect(dream).toContain("## Insights");
    expect(dream).toContain("Active: 2 repos touched this week");
    expect(dream).toContain("At risk: beta (6 files)");

    const speculation = readLatestSpeculation();
    expect(speculation).toContain("# Morpheus — Speculations");
    expect(speculation).toContain('[HIGH] alpha — last: "Alpha active branch"');
    expect(speculation).toContain("[MEDIUM] Verify base command handoff");
    expect(speculation).toContain("beta — 6 uncommitted files → `cd ");
  });

  test("help and speculate render branches use existing dream and speculation exports", async () => {
    await cmdDream({ help: true } as never);
    expect(logs.join("\n")).toContain("usage: maw dream [flags]");

    logs = [];
    scenario = "speculate";
    writeRecentFile(join(cwd, "ψ", "writing", "dreams", "2026-05-17_09-00_dream.md"), "# Dream\n\n- base dream item\n");
    writeRecentFile(join(cwd, "ψ", "memory", "morpheus", "2026-05-17_speculations.md"), "# Spec\n\n- base speculation item\n");

    await cmdDream({ speculate: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Latest dream");
    expect(output).toContain("base dream item");
    expect(output).toContain("Latest speculation");
    expect(output).toContain("base speculation item");
  });
});

function createRepo(dirName: string): string {
  const repoPath = join(ghqRoot, "github.com", "Soul-Brews-Studio", dirName);
  mkdirSync(join(repoPath, "ψ"), { recursive: true });
  return repoPath;
}

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${repos.join("\n")}\n`;
  if (cmd.includes("git -C") && cmd.includes("log -1 --format='%s'")) {
    if (cmd.includes("beta-oracle")) return "Beta risky branch";
    if (cmd.includes("lost-oracle")) return "Lost base branch";
    return "Alpha active branch";
  }
  if (cmd.includes("git -C") && cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes("lost-oracle") ? "2026-01-01T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    if (cmd.includes("beta-oracle")) return Array.from({ length: 6 }, (_, index) => ` M beta-${index}.ts`).join("\n");
    return "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    const repoPath = repos.find((repo) => cmd.includes(repo)) ?? repos[0]!;
    return `worktree ${repoPath}\n`;
  }
  if (cmd.includes("log --oneline --since='7 days ago'")) return "2";
  if (cmd.includes("log --oneline --since='30 days ago'")) return "5";
  if (cmd.includes("log -15 --format")) return "aaa111 2026-05-17 Base connection commit";
  if (cmd.includes("gh issue list")) return JSON.stringify([{ number: 11, title: "Base connection issue", state: "OPEN" }]);
  if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 12, title: "Base connection PR", state: "OPEN" }]);
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const project = url.searchParams.get("project") ?? "";
  searchQueries.push(query);

  if (query === "test") return jsonResponse(true, []);
  if (scenario === "connections") return jsonResponse(true, connectionResults(query, project));
  if (scenario === "between") return jsonResponse(true, betweenResults(query));
  return jsonResponse(true, []);
}

function connectionResults(query: string, project: string) {
  if (!project.endsWith("Soul-Brews-Studio/alpha-oracle")) return [];
  const base = join(repos[0]!, "ψ", "memory", "logs", "info");
  if (query.includes("what went wrong")) {
    return [arra("# Alpha retry timeout breaks exports\nSummary:\n- Alpha retry timeout blocks render exports", join(base, "2026-05-17_pain.md"), 0.95)];
  }
  if (query.includes("what should we build next")) {
    return [arra("Next Steps:\n- Fix Alpha retry timeout render exports", join(base, "2026-05-17_plan.md"), 0.8)];
  }
  if (query.includes("what shipped")) {
    return [arra("What Got Done:\n- Shipped alpha command base branch", join(base, "2026-05-17_gain.md"), 0.8)];
  }
  if (query.includes("pattern appeared again")) {
    return [arra("# Alpha retry timeout pattern protects exports\nSummary:\n- Alpha retry timeout pattern prevents regressions", join(base, "2026-05-17_memory.md"), 0.8)];
  }
  if (query.includes("energy momentum")) {
    return [arra("# Alpha render confidence returned\nSummary:\n- Base command coverage felt stable", join(base, "2026-05-17_feeling.md"), 0.6)];
  }
  return [];
}

function betweenResults(query: string) {
  const alphaBase = join(repos[0]!, "ψ", "memory", "logs", "info");
  if (query.includes("what went wrong")) {
    return [arra("# Alpha export render risk\nSummary:\n- Base command risk should be planned", join(alphaBase, "2026-05-17_pain.md"), 0.95)];
  }
  if (query.includes("what should we build next")) {
    return [arra("Next Steps:\n- Finish base command plan branch", join(alphaBase, "2026-05-17_plan.md"), 0.8)];
  }
  if (query.includes("next steps should build")) {
    return [arra("Next Steps:\n- Finish base command forgotten export branch", join(alphaBase, "2026-04-20_forgotten.md"), 0.9)];
  }
  if (query.includes("keeps happening same bug")) {
    return [arra("# Base command warning repeats\nSummary:\n- same branch keeps needing coverage", join(alphaBase, "2026-05-17_warning.md"), 0.9)];
  }
  return [];
}

function arra(content: string, source_file: string, score: number) {
  return { type: "retro", content, source_file, score };
}

function jsonResponse(ok: boolean, results: ReturnType<typeof arra>[]): Response {
  return { ok, json: async () => ({ results }) } as Response;
}

function writeRecentHandoff(repoPath: string, content: string): void {
  writeRecentFile(join(repoPath, "ψ", "inbox", "handoff", "2026-05-17_handoff.md"), content);
}

function writeRecentFile(filepath: string, content: string): void {
  mkdirSync(dirname(filepath), { recursive: true });
  writeFileSync(filepath, content);
  const recent = new Date("2026-05-17T00:00:00.000Z");
  utimesSync(filepath, recent, recent);
}

function readProjectDream(repoName: string): string {
  const projectDir = join(cwd, "ψ", "writing", "dreams", "project");
  const projectFile = readdirSync(projectDir).find((entry) => entry.endsWith(`_${repoName}_deep.md`));
  expect(projectFile).toBeDefined();
  return readFileSync(join(projectDir, projectFile!), "utf8");
}

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).filter((entry) => entry.endsWith("_dream.md")).sort().at(-1);
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}

function readLatestSpeculation(): string {
  const specDir = join(cwd, "ψ", "memory", "morpheus");
  const specFile = readdirSync(specDir).filter((entry) => entry.endsWith("_speculations.md")).sort().at(-1);
  expect(specFile).toBeDefined();
  return readFileSync(join(specDir, specFile!), "utf8");
}
