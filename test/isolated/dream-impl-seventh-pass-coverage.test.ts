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
let scenario: "connected-project" | "briefing-filters" | "all-cards" | "project-artifacts" | "offline-throw" | "search-throw" | "project-git-throw" = "connected-project";

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
      name: "seventh-pass-session",
      windows: [{ name: "ember", repo: "Soul-Brews-Studio/ember-oracle" }],
    },
  ],
}));

const {
  cmdDream,
  daysFromFile,
  deduplicateItems,
  extractDetail,
  extractRepo,
  extractSection,
  extractTitle,
  isNoise,
  shareKeywords,
} = await import("../../src/vendor/mpr-plugins/dream/impl.ts?seventh-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-seventh-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-seventh-cwd-"));
  repos = [createRepo("ember-oracle"), createRepo("risk-oracle"), createRepo("lost-oracle")];
  logs = [];
  commands = [];
  searchQueries = [];
  scenario = "connected-project";
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

describe("dream command seventh-pass coverage", () => {
  test("project deep dive with connected ARRA renders deep-only memory and feeling categories", async () => {
    scenario = "connected-project";

    await cmdDream({ project: "ember-oracle" } as never);

    const output = logs.join("\n");
    expect(output).toContain("oracle KB connected");
    expect(output).toContain("Dream — deep dive: ember-oracle");
    expect(output).toContain("PAIN — blocking or broken");
    expect(output).toContain("PLAN — next steps from retros");
    expect(output).toContain("GAIN — shipped this period");
    expect(output).toContain("MEMORY — patterns that repeat");
    expect(output).toContain("FEELING — emotional signals");
    expect(output).toContain("Connections");
    expect(output).toContain("has fix planned");
    expect(output).toContain("could prevent");
    expect(output).not.toContain("Recent commits");
    expect(output).not.toContain("Open issues");
    expect(output).not.toContain("Open PRs");
    expect(searchQueries).toContain("test");
    expect(searchQueries).toContain("what went wrong what error occurred how to fix");
    expect(searchQueries).toContain("energy momentum breakthrough frustration tension");

    const projectDream = readProjectDream("ember");
    expect(projectDream).toContain("# Dream Deep Dive — ember");
    expect(projectDream).toContain("**Oracle KB**: connected");
    expect(projectDream).toContain("## PAIN — blocking or broken");
    expect(projectDream).toContain("## FEELING — emotional signals");
    expect(projectDream).toContain("Ember retry timeout keeps failing");
    expect(projectDream).toContain("→ `maw workon ember`");
    expect(projectDream).not.toContain("## Recent Commits");
  });

  test("all mode renders connected project cards with wins, friction, and patterns", async () => {
    scenario = "all-cards";

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● ember");
    expect(output).toContain("4/week");
    expect(output).toContain("Ember all card shipped cleanly");
    expect(output).toContain("Ember all card friction needs gentler retries");
    expect(output).toContain("Ember all card repeated lesson");
    expect(output).toContain("→ maw workon ember");
    expect(output).toContain("📊 2/2 active repos shown");
    expect(searchQueries).toContain("ember shipped completed deployed merged");
    expect(searchQueries).toContain("ember friction improve problem could be better");
    expect(searchQueries).toContain("ember pattern lesson root cause always never");

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: connected");
  });



  test("briefing highlights verify handoffs and writes same-project coverage insight", async () => {
    scenario = "connected-project";
    writeRecentHandoff(repos[0]!, "| Priority | Item | Context |\n| --- | --- | --- |\n| Verify | Verify connected briefing handoff | Needs focus branch coverage |\n");

    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Verify connected briefing handoff");
    expect(output).toContain("[Verify]");

    const dream = readLatestDream();
    expect(dream).toContain("Verify connected briefing handoff");
    expect(dream).toContain("Coverage: 1/3 pains have plans in the same project");
  });

  test("semantic search failures and missing project lookups return cleanly", async () => {
    scenario = "search-throw";

    await cmdDream({} as never);

    expect(logs.join("\n")).toContain("saved →");
    expect(readLatestDream()).toContain("**Oracle KB**: connected");

    logs = [];
    scenario = "connected-project";
    await cmdDream({ project: "missing-seventh" } as never);

    const output = logs.join("\n");
    expect(output).toContain('project "missing-seventh" not found');
    expect(output).toContain("known: ember, risk, lost");
  });

  test("project deep dive tolerates git log command failures", async () => {
    scenario = "project-git-throw";

    await cmdDream({ project: "ember" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: ember");
    expect(output).not.toContain("Recent commits");
    expect(readProjectDream("ember")).not.toContain("## Recent Commits");
  });

  test("between mode writes speculation risks when briefing finds active high-confidence pain", async () => {
    scenario = "briefing-filters";

    await cmdDream({ between: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("speculations →");

    const speculation = readLatestSpeculation();
    expect(speculation).toContain("# Morpheus — Speculations");
    expect(speculation).toContain('[HIGH] ember — last: "Ember active branch"');
    expect(speculation).toContain("risk — 7 uncommitted files → `cd ");
  });

  test("project deep dive saves handoffs, git history, and GitHub sections", async () => {
    scenario = "project-artifacts";
    writeRecentHandoff(repos[0]!, [
      "| Priority | Item | Context |",
      "| --- | --- | --- |",
      "| **Verify** | Verify seventh artifact handoff | Blocks project artifact branch |",
      "- [ ] Follow seventh artifact checkbox",
    ].join("\n"));

    await cmdDream({ project: "emb" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: emb");
    expect(output).toContain("Verify seventh artifact handoff");
    expect(output).toContain("Follow seventh artifact checkbox");
    expect(output).toContain("Recent commits");
    expect(output).toContain("abc123 2026-05-17 Seventh artifact commit");
    expect(output).toContain("Open issues");
    expect(output).toContain("#7 Seventh artifact issue");
    expect(output).toContain("Open PRs");
    expect(output).toContain("#8 Seventh artifact PR");

    const projectDream = readProjectDream("ember");
    expect(projectDream).toContain("## PLAN — next steps from retros");
    expect(projectDream).toContain("Verify seventh artifact handoff");
    expect(projectDream).toContain("Follow seventh artifact checkbox");
    expect(projectDream).toContain("## Recent Commits");
    expect(projectDream).toContain("## Open Issues");
    expect(projectDream).toContain("## Open PRs");
  });

  test("help, speculate, and offline all-mode branches stay side-effect safe", async () => {
    await cmdDream({ help: true } as never);
    expect(logs.join("\n")).toContain("usage: maw dream [flags]");
    expect(logs.join("\n")).toContain("maw dream --between");

    logs = [];
    writeRecentFile(join(cwd, "ψ", "writing", "dreams", "2026-05-17_09-00_dream.md"), "# Dream\n\n- dream item kept\n- second dream item\n");
    writeRecentFile(join(cwd, "ψ", "memory", "morpheus", "2026-05-17_speculations.md"), "# Spec\n\n- speculation item kept\n");
    await cmdDream({ speculate: true } as never);
    const speculateOutput = logs.join("\n");
    expect(speculateOutput).toContain("Morpheus");
    expect(speculateOutput).toContain("Latest dream");
    expect(speculateOutput).toContain("dream item kept");
    expect(speculateOutput).toContain("Latest speculation");
    expect(speculateOutput).toContain("speculation item kept");

    logs = [];
    scenario = "offline-throw";
    await cmdDream({ all: true } as never);
    const offlineDream = readLatestDream();
    expect(logs.join("\n")).toContain("📊 2/2 active repos shown");
    expect(offlineDream).toContain("**Oracle KB**: offline");
  });

  test("exported helpers cover filename, metadata, repo, noise, dedupe, and keyword fallbacks", () => {
    expect(extractTitle("Summary: Seventh helper summary is long enough", "/tmp/unknown.md")).toBe("Seventh helper summary is long enough");
    expect(extractTitle("metadata only", "/tmp/Soul/ember-oracle/ψ/logs/2026-05-17_helper-fallback.md")).toBe("ember — helper fallback");
    expect(extractTitle("short", "/tmp/x.md")).toBe("");
    expect(extractSection("Next Steps:\n- one\n- two\n## Stop\n- no", "Next Steps")).toBe("one - two");
    expect(extractSection("Nothing useful", "Next Steps")).toBeNull();
    expect(extractDetail("---\ntitle: skip\ncreated: skip\nThis helper detail line is definitely long enough to keep")).toContain("helper detail line");
    expect(extractRepo("/tmp/parent/.claude/worktrees/agent-1/ψ/memory/log.md")).toBe("parent");
    expect(extractRepo("/tmp/no-psi/log.md")).toBe("unknown");
    expect(isNoise("buy BTC long position")).toBe(true);
    expect(isNoise("finish dream coverage helper")).toBe(false);
    expect(daysFromFile("/tmp/2026/05/17_note.md")).toBe(1);
    expect(daysFromFile("/tmp/no-date.md")).toBe(999);
    expect(shareKeywords("retry timeout pattern returns", "retry timeout pattern planned", 3)).toBe(true);
    expect(shareKeywords("session learned the thing", "session learned other", 1)).toBe(false);
    const deduped = deduplicateItems([
      dreamItem("pain", "ember", "Repeated helper title starts same way before suffix A"),
      dreamItem("pain", "ember", "Repeated helper title starts same way before suffix B"),
      dreamItem("gain", "ember", "Repeated helper title starts same way before suffix A"),
    ] as never);
    expect(deduped).toHaveLength(2);
  });

  test("briefing filters forgotten plans and reports stale plus uncommitted risk insights", async () => {
    scenario = "briefing-filters";

    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("PAIN — blocking or broken");
    expect(output).toContain("risk — 7 uncommitted files");
    expect(output).toContain("risk — 1 orphaned worktree(s)");
    expect(output).toContain("Forgotten");
    expect(output).toContain("ember: Finish seventh pass forgotten branch coverage");
    expect(output).not.toContain("Already shipped seventh-pass work");
    expect(output).not.toContain("continue as required");
    expect(output).toContain("Watch Out");
    expect(output).toContain("ember: Seventh warning repeats for active repo");
    expect(output).toContain("📊 2 active | 1 stale");

    const dream = readLatestDream();
    expect(dream).toContain("## Forgotten (planned but never done)");
    expect(dream).toContain("Finish seventh pass forgotten branch coverage");
    expect(dream).toContain("## LOST — abandoned >90 days");
    expect(dream).toContain("## Warnings");
    expect(dream).toContain("Seventh warning repeats for active repo");
    expect(dream).toContain("Forgotten: 1 repos silent >90d");
    expect(dream).toContain("At risk: risk (7 files)");
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
    if (cmd.includes("lost-oracle")) return "Lost repo last commit";
    if (cmd.includes("risk-oracle")) return "Risk repo active work";
    return "Ember active branch";
  }
  if (cmd.includes("git -C") && cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes("lost-oracle") ? "2026-01-01T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    if (cmd.includes("risk-oracle")) return Array.from({ length: 7 }, (_, index) => ` M file-${index}.ts`).join("\n");
    return "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    const repoPath = repos.find((repo) => cmd.includes(repo)) ?? repos[0]!;
    if (cmd.includes("risk-oracle")) return `worktree ${repoPath}\n\nworktree ${repoPath}-branch\n`;
    return `worktree ${repoPath}\n`;
  }
  if (cmd.includes("log --oneline --since='7 days ago'")) return cmd.includes("ember-oracle") ? "4" : "1";
  if (cmd.includes("log --oneline --since='30 days ago'")) return cmd.includes("ember-oracle") ? "9" : "2";
  if (cmd.includes("log -15 --format")) {
    if (scenario === "project-git-throw") throw new Error("git log unavailable");
    if (scenario === "project-artifacts" && cmd.includes("ember-oracle")) return "abc123 2026-05-17 Seventh artifact commit\ndef456 2026-05-16 Earlier artifact commit";
    return "";
  }
  if (cmd.includes("gh issue list")) {
    if (scenario === "project-artifacts") return JSON.stringify([{ number: 7, title: "Seventh artifact issue", state: "OPEN" }]);
    return "[]";
  }
  if (cmd.includes("gh pr list")) {
    if (scenario === "project-artifacts") return JSON.stringify([{ number: 8, title: "Seventh artifact PR", state: "OPEN" }]);
    return "[]";
  }
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const project = url.searchParams.get("project") ?? "";
  searchQueries.push(query);

  if (scenario === "offline-throw") throw new Error("offline seventh pass");
  if (query === "test") return jsonResponse(true, []);
  if (scenario === "search-throw") throw new Error("search unavailable");
  if (scenario === "connected-project") return jsonResponse(true, connectedProjectResults(query, project));
  if (scenario === "all-cards") return jsonResponse(true, allCardResults(query));
  if (scenario === "project-artifacts") return jsonResponse(true, []);
  return jsonResponse(true, briefingResults(query));
}

function connectedProjectResults(query: string, project: string) {
  if (!project.endsWith("Soul-Brews-Studio/ember-oracle")) return [];
  const base = join(repos[0]!, "ψ", "memory", "logs", "info");
  if (query.includes("what went wrong")) {
    return [arra("# Ember retry timeout keeps failing\nSummary:\n- Ember retry timeout needs planned fix", join(base, "2026-05-17_pain.md"), 0.95)];
  }
  if (query.includes("what should we build next")) {
    return [arra("Next Steps:\n- Fix Ember retry timeout with isolated coverage", join(base, "2026-05-17_plan.md"), 0.8)];
  }
  if (query.includes("what shipped")) {
    return [arra("What Got Done:\n- Shipped ember deep connected coverage", join(base, "2026-05-17_gain.md"), 0.7)];
  }
  if (query.includes("pattern appeared again")) {
    return [arra("# Ember retry timeout pattern keeps recurring\nSummary:\n- Repeated retry timeout pattern", join(base, "2026-05-17_memory.md"), 0.9)];
  }
  if (query.includes("energy momentum")) {
    return [arra("# Ember frustration turned into momentum\nSummary:\n- The team felt relief after the branch landed", join(base, "2026-05-17_feeling.md"), 0.6)];
  }
  return [];
}

function allCardResults(query: string) {
  const emberBase = join(repos[0]!, "ψ", "memory", "logs", "info");
  const riskBase = join(repos[1]!, "ψ", "memory", "logs", "info");
  if (query.includes("ember shipped completed deployed merged")) {
    return [
      arra("Session Summary: Ember all card shipped cleanly. Follow-up sentence ignored", join(emberBase, "2026-05-17_gain.md"), 0.9),
      arra("Session Summary: Irrelevant should be filtered", join(riskBase, "2026-05-17_gain.md"), 0.9),
    ];
  }
  if (query.includes("ember friction improve")) {
    return [arra("What Could Improve:\nEmber all card friction needs gentler retries. Extra sentence", join(emberBase, "2026-05-17_retro.md"), 0.8)];
  }
  if (query.includes("ember pattern lesson")) {
    return [arra("# Ember all card repeated lesson\nSummary:\n- repeated branch covered", join(emberBase, "2026-05-17_learning.md"), 0.8)];
  }
  if (query.includes("risk shipped completed deployed merged")) {
    return [arra("Summary: Risk all card shipped too", join(riskBase, "2026-05-17_gain.md"), 0.8)];
  }
  return [];
}

function briefingResults(query: string) {
  const emberBase = join(repos[0]!, "ψ", "memory", "logs", "info");
  if (query.includes("next steps should build")) {
    return [
      arra("Next Steps:\n- Finish seventh pass forgotten branch coverage", join(emberBase, "2026-04-25_forgotten.md"), 0.9),
      arra("Next Steps:\n- Finish seventh pass forgotten branch coverage with duplicate phrasing", join(emberBase, "2026-04-24_duplicate.md"), 0.8),
      arra("Next Steps:\n- Already shipped seventh-pass work", join(emberBase, "2026-04-23_done.md"), 0.9),
      arra("Pending:\n- continue as required", join(emberBase, "2026-04-22_continue.md"), 0.9),
      arra("Next Steps:\n- Too fresh to be forgotten", join(emberBase, "2026-05-10_fresh.md"), 0.9),
      arra("Next Steps:\n- Too old to stay actionable", join(emberBase, "2026-02-01_old.md"), 0.9),
    ];
  }
  if (query.includes("keeps happening same bug")) {
    return [arra("# Seventh warning repeats for active repo\nSummary:\n- same active repo risk", join(emberBase, "2026-05-17_warning.md"), 0.9)];
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

function dreamItem(category: string, project: string, title: string) {
  return { category, project, title, detail: "", source: "/tmp/source.md", confidence: "high", daysAgo: 0 };
}

function readLatestSpeculation(): string {
  const specDir = join(cwd, "ψ", "memory", "morpheus");
  const specFile = readdirSync(specDir).filter((entry) => entry.endsWith("_speculations.md")).sort().at(-1);
  expect(specFile).toBeDefined();
  return readFileSync(join(specDir, specFile!), "utf8");
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
