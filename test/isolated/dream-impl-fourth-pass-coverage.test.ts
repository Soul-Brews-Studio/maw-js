import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let activeRepo = "";
let quietRepo = "";
let logs: string[] = [];
let commands: string[] = [];
let fetchOk = true;
let throwGitState = false;

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
      name: "fourth-pass-session",
      windows: [{ name: "main", repo: "Soul-Brews-Studio/fourth-oracle" }],
    },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?fourth-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-fourth-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-fourth-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  activeRepo = join(ownerRoot, "fourth-oracle");
  quietRepo = join(ownerRoot, "quiet-oracle");

  mkdirSync(join(activeRepo, "ψ", "inbox", "handoff"), { recursive: true });
  mkdirSync(join(quietRepo, "ψ"), { recursive: true });
  writeFileSync(
    join(activeRepo, "ψ", "inbox", "handoff", "2026-05-17_latest.md"),
    [
      "| Priority | Item | Context |",
      "| --- | --- | --- |",
      "| Verify | Verify fourth pass dream coverage | Blocks coverage gate |",
      "| Later | Lower-priority dream followup | Should save but not lead briefing |",
      "- [ ] Finish fourth pass checkbox coverage",
    ].join("\n"),
  );
  const latestTime = new Date("2026-05-17T12:00:00.000Z");
  utimesSync(join(activeRepo, "ψ", "inbox", "handoff", "2026-05-17_latest.md"), latestTime, latestTime);
  writeFileSync(join(activeRepo, "ψ", "inbox", "handoff", "2026-05-10_old.md"), "- [ ] Old handoff should be ignored\n");
  const oldTime = new Date("2026-05-10T00:00:00.000Z");
  utimesSync(join(activeRepo, "ψ", "inbox", "handoff", "2026-05-10_old.md"), oldTime, oldTime);

  process.chdir(cwd);
  logs = [];
  commands = [];
  fetchOk = true;
  throwGitState = false;
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

describe("dream command fourth-pass coverage", () => {
  test("default connected briefing uses latest handoff, overflow hints, and generated insights", async () => {
    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Verify fourth pass dream coverage");
    expect(output).toContain("Finish fourth pass checkbox coverage");
    expect(output).not.toContain("Old handoff should be ignored");
    expect(output).not.toContain("Lower-priority dream followup");
    expect(output).toContain("… 1 more (--all)");
    expect(output).toContain("📊 2 active");

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: connected");
    expect(dream).toContain("Verify: Blocks coverage gate");
    expect(dream).toContain("Soon");
    expect(dream).toContain("Hotspots: fourth (3)");
    expect(dream).toContain("Coverage: 4/4 pains have plans in the same project");
    expect(dream).toContain("At risk: fourth (7 files)");
    expect(commands.some(cmd => cmd.includes("worktree list --porcelain"))).toBe(true);
  });

  test("all mode stays useful when semantic search is offline and git state commands fail", async () => {
    fetchOk = false;
    throwGitState = true;

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● fourth");
    expect(output).toContain("0/week");
    expect(output).toContain("→ maw workon fourth");
    expect(output).toContain("● quiet");
    expect(output).toContain("2/2 active repos shown");
    expect(output).toContain("saved →");

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: offline");
    expect(dream).toContain("**Verify fourth pass dream coverage**");
    expect(dream).not.toContain("semantic pain fourth");
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${activeRepo}\n${quietRepo}\n`;
  if (throwGitState && /status --porcelain|worktree list --porcelain/.test(cmd)) {
    throw new Error("git state unavailable");
  }
  if (cmd.includes("log -1 --format='%s'")) return cmd.includes(quietRepo) ? "Quiet fourth pass" : "Active fourth pass";
  if (cmd.includes("log -1 --format='%ct'")) return String(Math.floor(new Date("2026-05-17T00:00:00.000Z").getTime() / 1000));
  if (cmd.includes("status --porcelain")) return cmd.includes(activeRepo) ? " M a\n M b\n M c\n M d\n M e\n M f\n M g\n" : "";
  if (cmd.includes("worktree list --porcelain")) {
    return cmd.includes(activeRepo) ? `worktree ${activeRepo}\n\nworktree ${activeRepo}-agent\n` : `worktree ${quietRepo}\n`;
  }
  if (cmd.includes("--since='7 days ago'") || cmd.includes("--since='30 days ago'")) return "0\n";
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  if (query === "test") return { ok: fetchOk, json: async () => ({ results: [] }) } as Response;
  return { ok: true, json: async () => ({ results: resultsFor(query) }) } as Response;
}

function resultsFor(query: string) {
  if (query.includes("what went wrong")) {
    return [
      arra("# semantic pain fourth alpha\nSummary:\n- First semantic pain remains visible", 0.9, "2026-05-17_pain-a.md"),
    ];
  }
  if (query.includes("what should we build next")) {
    return [arra("Next Steps:\n- Fix semantic pain fourth alpha with tests", 0.8, "2026-05-17_plan.md")];
  }
  if (query.includes("what shipped")) {
    return [arra("Session Summary: Shipped fourth pass coverage scaffolding for dream command", 0.8, "2026-05-17_gain.md")];
  }
  if (query.includes("pattern appeared again")) {
    return [
      arra("# fourth memory pattern one", 0.8, "2026-05-17_memory-a.md"),
      arra("# fourth memory pattern two", 0.8, "2026-05-17_memory-b.md"),
      arra("# fourth memory pattern three", 0.8, "2026-05-17_memory-c.md"),
    ];
  }
  return [];
}

function arra(content: string, score: number, file: string) {
  return {
    type: "retro",
    content,
    score,
    source_file: join(activeRepo, "ψ", "memory", file),
  };
}

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).find(name => name.endsWith("_dream.md"));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}
