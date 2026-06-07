import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let focusRepo = "";
let staleRepo = "";
let quietRepo = "";
let logs: string[] = [];
let commands: string[] = [];
let searchQueries: string[] = [];
let fetchMode: "normal" | "throw-searches" | "non-ok-searches" = "normal";
let gitLogFails = false;

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
      name: "focused-session",
      windows: [
        { name: "main", repo: "Soul-Brews-Studio/focus-oracle" },
        { name: "missing", repo: "Soul-Brews-Studio/missing-oracle" },
      ],
    },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-focused-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-focused-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  focusRepo = join(ownerRoot, "focus-oracle");
  staleRepo = join(ownerRoot, "old-oracle");
  quietRepo = join(ownerRoot, "quiet-oracle");

  mkdirSync(join(focusRepo, "ψ", "inbox", "handoff"), { recursive: true });
  mkdirSync(join(staleRepo, "ψ"), { recursive: true });
  mkdirSync(join(quietRepo, "ψ"), { recursive: true });
  const handoff = join(focusRepo, "ψ", "inbox", "handoff", "2026-05-17_focus.md");
  writeFileSync(
    handoff,
    "| Priority | Item | Context |\n| --- | --- | --- |\n| Later | Review focused dream coverage | Needs reviewer context |\n- [ ] Backfill focused dream coverage\n",
  );
  const handoffTime = new Date("2026-05-17T00:00:00.000Z");
  utimesSync(handoff, handoffTime, handoffTime);

  process.chdir(cwd);
  logs = [];
  commands = [];
  searchQueries = [];
  fetchMode = "normal";
  gitLogFails = false;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
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

describe("dream command focused branch coverage", () => {
  test("pain focus keeps semantic pain and git risk while suppressing plan/gain scans", async () => {
    await cmdDream({ pain: true } as never);

    const savedDream = readLatestDream();
    expect(savedDream).toContain("Plugin branch fails gracefully");
    expect(savedDream).toContain("focus — 6 uncommitted files");
    expect(savedDream).toContain("focus — 1 orphaned worktree(s)");
    expect(savedDream).toContain("old — silent 168d");
    expect(savedDream).toContain("## Forgotten (planned but never done)");
    expect(savedDream).toContain("## Warnings");
    expect(savedDream).not.toContain("Pending focused dream branch coverage");
    expect(savedDream).not.toContain("Shipped focused dream coverage");
    expect(searchQueries.some(q => q.includes("what went wrong"))).toBe(true);
    expect(searchQueries.some(q => q.includes("what should we build next"))).toBe(false);
    expect(searchQueries.some(q => q.includes("what shipped"))).toBe(false);
    expect(searchQueries.some(q => q.includes("energy momentum"))).toBe(false);
  });

  test("plan focus uses Pending fallback and handoff priority without pain classification", async () => {
    await cmdDream({ plan: true } as never);

    const output = logs.join("\n");
    const savedDream = readLatestDream();
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Backfill focused dream coverage");
    expect(savedDream).toContain("focus — Write focused dream branch coverage");
    expect(savedDream).toContain("Later: Needs reviewer context");
    expect(savedDream).toContain("old — silent 168d");
    expect(savedDream).not.toContain("focus — 6 uncommitted files");
    expect(searchQueries.some(q => q.includes("what should we build next"))).toBe(true);
    expect(searchQueries.some(q => q.includes("what went wrong"))).toBe(false);
    expect(searchQueries.some(q => q.includes("what shipped"))).toBe(false);
  });

  test("gain focus uses What Got Done fallback and tolerates non-ok semantic searches", async () => {
    fetchMode = "non-ok-searches";

    await cmdDream({ gain: true } as never);

    const output = logs.join("\n");
    const savedDream = readLatestDream();
    expect(output).toContain("Dream");
    expect(output).toContain("saved →");
    expect(savedDream).toContain("**Oracle KB**: connected");
    expect(savedDream).toContain("old — silent 168d");
    expect(savedDream).not.toContain("Shipped focused dream coverage");
    expect(searchQueries.some(q => q.includes("what shipped"))).toBe(true);
    expect(searchQueries.some(q => q.includes("what went wrong"))).toBe(false);
    expect(searchQueries.some(q => q.includes("what should we build next"))).toBe(false);
  });

  test("project deep dive still saves git and handoff findings when ARRA searches and GitHub reads fail", async () => {
    fetchMode = "throw-searches";
    gitLogFails = true;

    await cmdDream({ project: "focus-oracle" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: focus-oracle");
    expect(output).toContain("oracle KB connected");
    expect(output).toContain("saved →");
    expect(output).not.toContain("Recent commits");
    expect(output).not.toContain("Open issues");
    expect(output).not.toContain("Open PRs");

    const projectDream = readLatestProjectDream();
    expect(projectDream).toContain("# Dream Deep Dive — focus");
    expect(projectDream).toContain("**Oracle KB**: connected");
    expect(projectDream).toContain("focus — 6 uncommitted files");
    expect(projectDream).toContain("Backfill focused dream coverage");
    expect(searchQueries.some(q => q.includes("what went wrong"))).toBe(true);
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${focusRepo}\n${staleRepo}\n${quietRepo}\n`;
  if (cmd.includes("log -15 --format")) {
    if (gitLogFails) throw new Error("git log unavailable");
    return "abc123 2026-05-17 Focus dream coverage";
  }
  if (cmd.includes("gh issue list")) return "not json";
  if (cmd.includes("gh pr list")) throw new Error("gh unavailable");
  if (cmd.includes("log -1 --format='%s'")) {
    if (cmd.includes(staleRepo)) return "Dormant baseline";
    if (cmd.includes(quietRepo)) return "Quiet branch";
    return "Focused branch coverage";
  }
  if (cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes(staleRepo)
      ? "2025-12-01T00:00:00.000Z"
      : cmd.includes(quietRepo)
        ? "2026-05-16T00:00:00.000Z"
        : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    return cmd.includes(focusRepo) ? " M a\n M b\n M c\n M d\n M e\n M f\n" : "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    if (cmd.includes(focusRepo)) return `worktree ${focusRepo}\n\nworktree ${focusRepo}-branch\n`;
    return `worktree ${cmd.includes(staleRepo) ? staleRepo : quietRepo}\n`;
  }
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  if (query === "test") return response(true, []);

  searchQueries.push(query);
  if (fetchMode === "throw-searches") throw new Error(`ARRA search failed for ${query}`);
  if (fetchMode === "non-ok-searches") return response(false, []);

  return response(true, resultsFor(query, url.searchParams.get("project") ?? ""));
}

function resultsFor(query: string, project: string) {
  if (project && !project.includes("focus-oracle")) return [];

  if (query.includes("what went wrong")) {
    return [
      arra("# BTC long position close plan\nSummary: market noise should be ignored", 0.9, "2026-05-17_noise.md"),
      arra("# Plugin branch fails gracefully\nSummary:\n- Focused pain branch stays visible", 0.55, "2026-05-16_pain.md"),
      arra("# Old pain should be skipped\nSummary:\n- This is outside the recent window", 0.9, "2026-03-01_old.md"),
    ];
  }
  if (query.includes("what should we build next")) {
    return [arra("Pending:\n- Write focused dream branch coverage", 0.8, "2026-05-14_plan.md")];
  }
  if (query.includes("what shipped")) {
    return [arra("What Got Done:\n- Shipped focused dream coverage", 0.8, "2026-05-15_gain.md")];
  }
  if (query.includes("next steps should build")) {
    return [
      arra(
        "Next Session:\n- [ ] Backfill branch-specific dream command tests\n- completed old task should not show\n- continue as required",
        0.7,
        "2026-05-01_forgotten.md",
      ),
      arra("Next Steps:\n- Too recent to be forgotten", 0.7, "2026-05-10_recent.md"),
      arra("Summary:\n- No next-step section here", 0.7, "2026-04-25_no_section.md"),
    ];
  }
  if (query.includes("keeps happening same bug")) {
    return [
      arra("# Plugin branch gap keeps happening\nSummary:\n- Active repo warning", 0.8, "2026-05-15_warning.md"),
      {
        ...arra("# Ghost branch gap keeps happening\nSummary:\n- Inactive repo warning", 0.8, "2026-05-15_ghost.md"),
        source_file: "/vault/ghost-oracle/ψ/memory/logs/info/2026-05-15_ghost.md",
      },
      arra("# BTC long position recurring\nSummary:\n- Noise warning", 0.8, "2026-05-15_noise_warning.md"),
    ];
  }
  return [];
}

function arra(content: string, score: number, filename: string) {
  return {
    content,
    type: "retro",
    source_file: `/vault/focus-oracle/ψ/memory/logs/info/${filename}`,
    score,
  };
}

function response(ok: boolean, results: ReturnType<typeof arra>[]): Response {
  return { ok, json: async () => ({ results }) } as Response;
}

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).find(name => name.endsWith("_dream.md"));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}

function readLatestProjectDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams", "project");
  const dreamFile = readdirSync(dreamsDir).find(name => name.endsWith("_focus_deep.md"));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}
