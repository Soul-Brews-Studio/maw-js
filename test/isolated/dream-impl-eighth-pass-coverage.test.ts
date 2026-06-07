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
let scenario: "search-non-ok" | "health-non-ok" | "project-invalid-gh" | "empty-speculate" = "search-non-ok";

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
      name: "eighth-pass-session",
      windows: [
        { name: "phoenix", repo: "Soul-Brews-Studio/phoenix-oracle" },
        { name: "duplicate", repo: "Soul-Brews-Studio/phoenix-oracle" },
        { name: "missing", repo: "Soul-Brews-Studio/missing-oracle" },
      ],
    },
  ],
}));

const { cmdDream, extractSection, extractTitle } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?eighth-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-eighth-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-eighth-cwd-"));
  repos = [createRepo("phoenix-oracle"), createRepo("quiet-oracle"), createRepo("fragile-oracle")];
  logs = [];
  commands = [];
  searchQueries = [];
  scenario = "search-non-ok";
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

describe("dream command eighth-pass coverage", () => {
  test("default briefing tolerates non-ok ARRA searches while saving repo and handoff signals", async () => {
    scenario = "search-non-ok";
    writeRecentHandoff(repos[0]!, [
      "| Priority | Item | Context |",
      "| --- | --- | --- |",
      "| Later | Revisit eighth pass table without context | |",
      "* [ ] Finish eighth pass checkbox handoff",
    ].join("\n"));

    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Finish eighth pass checkbox handoff");
    expect(output).toContain("phoenix — 6 uncommitted files");
    expect(output).toContain("phoenix — 2 orphaned worktree(s)");
    expect(output).toContain("📊 2 active | 1 stale");
    expect(searchQueries).toContain("what went wrong what error occurred how to fix");
    expect(commands.filter((cmd) => cmd === "ghq list -p 2>/dev/null")).toHaveLength(1);

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: connected");
    expect(dream).toContain("**Revisit eighth pass table without context** [medium, 1d ago]");
    expect(dream).toContain("Later");
    expect(dream).toContain("**Finish eighth pass checkbox handoff** [high, 1d ago]");
    expect(dream).toContain("## LOST — abandoned >90 days");
    expect(dream).toContain("At risk: phoenix (6 files)");
  });

  test("all mode skips semantic project cards when health check is non-ok", async () => {
    scenario = "health-non-ok";

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● phoenix");
    expect(output).toContain("0/week");
    expect(output).toContain("→ maw workon phoenix");
    expect(output).toContain("📊 2/2 active repos shown");
    expect(searchQueries).toEqual(["test"]);
    expect(readLatestDream()).toContain("**Oracle KB**: offline");
  });

  test("project deep dive includes stale semantic hits and ignores malformed GitHub JSON", async () => {
    scenario = "project-invalid-gh";

    await cmdDream({ project: "phoenix" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: phoenix");
    expect(output).toContain("oracle KB connected");
    expect(output).toContain("Phoenix ancient failure still matters");
    expect(output).toContain("Recent commits");
    expect(output).toContain("abc999 2026-05-16 Eighth project commit");
    expect(output).not.toContain("Open issues");
    expect(output).not.toContain("Open PRs");

    const projectDream = readProjectDream("phoenix");
    expect(projectDream).toContain("**Phoenix ancient failure still matters** [medium, 47d]");
    expect(projectDream).toContain("This old learning remains relevant in deep mode");
    expect(projectDream).toContain("## Recent Commits");
    expect(commands.some((cmd) => cmd.includes("gh issue list --repo Soul-Brews-Studio/phoenix-oracle"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("gh pr list --repo Soul-Brews-Studio/phoenix-oracle"))).toBe(true);
  });

  test("speculate mode with no recent artifacts prints only the header", async () => {
    scenario = "empty-speculate";

    await cmdDream({ speculate: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Morpheus");
    expect(output).not.toContain("Latest dream");
    expect(output).not.toContain("Latest speculation");
  });

  test("helper edge cases cover inline sections and short heading fallback", () => {
    expect(extractSection("Pending: Finish inline eighth pass branch\n## Stop\n- ignored", "Pending")).toBe("Finish inline eighth pass branch");
    expect(extractSection("**Pending**\n- Finish bold eighth pass branch\n**Stop**", "Pending")).toBe("Finish bold eighth pass branch");
    expect(extractTitle("# short\nSummary:\n- too short", "/tmp/github.com/Soul-Brews-Studio/phoenix-oracle/ψ/memory/logs/info/x.md")).toBe("");
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
    if (cmd.includes("quiet-oracle")) return "Quiet repo went dormant";
    if (cmd.includes("fragile-oracle")) return "Fragile repo active";
    return "Phoenix active branch";
  }
  if (cmd.includes("git -C") && cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes("quiet-oracle") ? "2026-01-15T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    if (cmd.includes("fragile-oracle")) throw new Error("status unavailable");
    if (cmd.includes("phoenix-oracle")) return Array.from({ length: 6 }, (_, index) => ` M eighth-${index}.ts`).join("\n");
    return "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    if (cmd.includes("fragile-oracle")) throw new Error("worktree unavailable");
    if (cmd.includes("phoenix-oracle")) return `worktree ${repos[0]}\n\nworktree ${repos[0]}-a\n\nworktree ${repos[0]}-b\n`;
    return `worktree ${repos.find((repo) => cmd.includes(repo)) ?? repos[0]}\n`;
  }
  if (cmd.includes("log --oneline --since='7 days ago'")) return "0";
  if (cmd.includes("log --oneline --since='30 days ago'")) return "0";
  if (cmd.includes("log -15 --format")) return "abc999 2026-05-16 Eighth project commit";
  if (cmd.includes("gh issue list")) return "not json";
  if (cmd.includes("gh pr list")) return "not json";
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  searchQueries.push(query);

  if (query === "test") return jsonResponse(scenario !== "health-non-ok", []);
  if (scenario === "search-non-ok") return jsonResponse(false, []);
  if (scenario === "project-invalid-gh") return jsonResponse(true, projectResults(query));
  return jsonResponse(true, []);
}

function projectResults(query: string) {
  const base = join(repos[0]!, "ψ", "memory", "logs", "info");
  if (query.includes("what went wrong")) {
    return [arra("# Phoenix ancient failure still matters\nSummary:\n- This old learning remains relevant in deep mode", join(base, "2026-04-01_old_pain.md"), 0.6)];
  }
  if (query.includes("energy momentum")) {
    return [arra("# buy BTC long position", join(base, "2026-05-17_noise.md"), 0.9)];
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

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).filter((entry) => entry.endsWith("_dream.md")).sort().at(-1);
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}

function readProjectDream(repoName: string): string {
  const projectDir = join(cwd, "ψ", "writing", "dreams", "project");
  const projectFile = readdirSync(projectDir).find((entry) => entry.endsWith(`_${repoName}_deep.md`));
  expect(projectFile).toBeDefined();
  return readFileSync(join(projectDir, projectFile!), "utf8");
}
