import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let repoPaths: string[] = [];
let fleetRepos: string[] = [];
let logs: string[] = [];
let commands: string[] = [];
let searchQueries: string[] = [];
let scenario: "cards-offline" | "between-json-failures" = "cards-offline";

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
      name: "sixth-pass-session",
      windows: fleetRepos.map((repo, index) => ({ name: `win-${index + 1}`, repo })),
    },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?sixth-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-sixth-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-sixth-cwd-"));
  repoPaths = [];
  fleetRepos = [];
  logs = [];
  commands = [];
  searchQueries = [];
  scenario = "cards-offline";
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

describe("dream command sixth-pass coverage", () => {
  test("all mode caps project cards at ten unique active repos when ARRA is offline", async () => {
    repoPaths = Array.from({ length: 11 }, (_, index) => createRepo(`card-${String(index + 1).padStart(2, "0")}-oracle`));
    fleetRepos = ["Soul-Brews-Studio/card-01-oracle"];
    scenario = "cards-offline";

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● card-01");
    expect(output).toContain("● card-10");
    expect(output).not.toContain("● card-11");
    expect(output).toContain("10/11 active repos shown");
    expect(output).toContain("saved →");
    expect(searchQueries).toEqual(["test"]);
    expect(commands.filter((cmd) => cmd === "ghq list -p 2>/dev/null")).toHaveLength(1);

    const dream = readLatestDream();
    expect(dream).toContain("**Scanned**: 11 repos | **Oracle KB**: offline");
  });

  test("between mode writes useful speculation content while failed ARRA result parsing stays non-fatal", async () => {
    const sparkRepo = createRepo("spark-oracle");
    repoPaths = [sparkRepo];
    fleetRepos = ["Soul-Brews-Studio/spark-oracle"];
    scenario = "between-json-failures";

    await cmdDream({ between: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("speculations →");
    expect(output).not.toContain("Forgotten");
    expect(output).not.toContain("Watch Out");
    expect(searchQueries.some((query) => query.includes("next steps should build"))).toBe(true);
    expect(searchQueries.some((query) => query.includes("keeps happening same bug"))).toBe(true);

    const dream = readLatestDream();
    expect(dream).toContain("Speculation pain branch stays high confidence");
    expect(dream).toContain("Speculation medium pain should stay out of risks");
    expect(dream).toContain("spark — Finish sixth-pass speculation assertions");
    expect(dream).not.toContain("## Forgotten");
    expect(dream).not.toContain("## Warnings");

    const speculation = readLatestSpeculation();
    expect(speculation).toContain("## Likely next session");
    expect(speculation).toContain('- [HIGH] spark — last: "Sixth pass branch work"');
    expect(speculation).toContain("- [MEDIUM] spark — Finish sixth-pass speculation assertions");
    expect(speculation).toContain("## Risks");
    expect(speculation).toContain("Speculation pain branch stays high confidence → `maw workon spark`");
    expect(speculation).not.toContain("Speculation medium pain should stay out of risks");
  });
});

function createRepo(dirName: string): string {
  const repoPath = join(ghqRoot, "github.com", "Soul-Brews-Studio", dirName);
  mkdirSync(join(repoPath, "ψ"), { recursive: true });
  return repoPath;
}

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${repoPaths.join("\n")}\n`;
  if (cmd.includes("log -1 --format='%s'")) return cmd.includes("spark-oracle") ? "Sixth pass branch work" : "Card branch work";
  if (cmd.includes("log -1 --format='%ct'")) return String(Math.floor(new Date("2026-05-17T00:00:00.000Z").getTime() / 1000));
  if (cmd.includes("status --porcelain")) return "";
  if (cmd.includes("worktree list --porcelain")) {
    const repoPath = repoPaths.find((path) => cmd.includes(path)) ?? repoPaths[0] ?? cwd;
    return `worktree ${repoPath}\n`;
  }
  if (cmd.includes("--since='7 days ago'")) return "5\n";
  if (cmd.includes("--since='30 days ago'")) return "12\n";
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  searchQueries.push(query);

  if (query === "test") {
    return response(scenario === "between-json-failures", []);
  }

  if (scenario !== "between-json-failures") {
    return response(false, []);
  }

  if (query.includes("next steps should build") || query.includes("keeps happening same bug")) {
    return { ok: true, json: async () => { throw new Error(`bad ARRA payload for ${query}`); } } as Response;
  }

  return response(true, resultsFor(query));
}

function resultsFor(query: string) {
  const sparkRepo = repoPaths.find((path) => path.endsWith("spark-oracle")) ?? "/vault/spark-oracle";
  if (query.includes("what went wrong")) {
    return [
      arra(sparkRepo, "# Speculation pain branch stays high confidence\nSummary:\n- The risk list should preserve the action hint", 0.9, "2026-05-17_high_pain.md"),
      arra(sparkRepo, "# Speculation medium pain should stay out of risks\nSummary:\n- It can appear in the dream without becoming a high-risk speculation", 0.5, "2026-05-17_medium_pain.md"),
    ];
  }
  if (query.includes("what should we build next")) {
    return [arra(sparkRepo, "Next Steps:\n- Finish sixth-pass speculation assertions", 0.8, "2026-05-17_plan.md")];
  }
  if (query.includes("what shipped")) return [];
  if (query.includes("pattern appeared again")) return [];
  if (query.includes("energy momentum")) return [];
  return [];
}

function arra(repoPath: string, content: string, score: number, file: string) {
  return {
    type: "retro",
    content,
    score,
    source_file: join(repoPath, "ψ", "memory", "logs", "info", file),
  };
}

function response(ok: boolean, results: ReturnType<typeof arra>[]): Response {
  return { ok, json: async () => ({ results }) } as Response;
}

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).find((entry) => entry.endsWith("_dream.md"));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}

function readLatestSpeculation(): string {
  const specDir = join(cwd, "ψ", "memory", "morpheus");
  const specFile = readdirSync(specDir).find((entry) => entry.endsWith("_speculations.md"));
  expect(specFile).toBeDefined();
  return readFileSync(join(specDir, specFile!), "utf8");
}
