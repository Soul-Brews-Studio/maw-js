import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let mazeRepo = "";
let quietRepo = "";
let logs: string[] = [];
let commands: string[] = [];
let scenario: "project-offline" | "cards" = "project-offline";
let throwMomentum = false;

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
      name: "maze-session",
      windows: [{ name: "main", repo: "Soul-Brews-Studio/maze-oracle" }],
    },
    {
      name: "quiet-session",
      windows: [{ name: "quiet", repo: "Soul-Brews-Studio/quiet-oracle" }],
    },
  ],
}));

const {
  cmdDream,
  extractDetail,
  extractSection,
  extractTitle,
} = await import("../../src/vendor/mpr-plugins/dream/impl.ts?fifth-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-fifth-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-fifth-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  mazeRepo = join(ownerRoot, "maze-oracle");
  quietRepo = join(ownerRoot, "quiet-oracle");

  mkdirSync(join(mazeRepo, "ψ", "inbox", "handoff"), { recursive: true });
  mkdirSync(join(quietRepo, "ψ"), { recursive: true });

  const latestHandoff = join(mazeRepo, "ψ", "inbox", "handoff", "2026-05-17_latest.md");
  writeFileSync(
    latestHandoff,
    [
      "| Priority | Item | Context |",
      "| --- | --- | --- |",
      "| **Verify** | Finish maze dream verification | Needs offline deep-dive followup |",
      "- [ ] Backfill maze checkbox",
    ].join("\n"),
  );
  const latestTime = new Date("2026-05-17T12:00:00.000Z");
  utimesSync(latestHandoff, latestTime, latestTime);

  const olderHandoff = join(mazeRepo, "ψ", "inbox", "handoff", "2026-05-16_older.md");
  writeFileSync(olderHandoff, "- [ ] Older handoff should not win\n");
  const olderTime = new Date("2026-05-16T00:00:00.000Z");
  utimesSync(olderHandoff, olderTime, olderTime);

  const ignoredText = join(mazeRepo, "ψ", "inbox", "handoff", "2026-05-18_ignore.txt");
  writeFileSync(ignoredText, "not markdown");

  process.chdir(cwd);
  logs = [];
  commands = [];
  scenario = "project-offline";
  throwMomentum = false;
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

describe("dream command fifth-pass coverage", () => {
  test("project deep dive resolves partial names offline, keeps latest bold handoff, and survives issue-list parse failures", async () => {
    scenario = "project-offline";

    await cmdDream({ project: "maz" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: maz");
    expect(output).toContain("oracle KB offline");
    expect(output).toContain(`${mazeRepo}`);
    expect(output).toContain("Recent commits");
    expect(output).toContain("Open PRs");
    expect(output).not.toContain("Open issues");
    expect(output).toContain("Finish maze dream verification");
    expect(output).toContain("Backfill maze checkbox");
    expect(output).not.toContain("Older handoff should not win");
    expect(output).toContain("saved →");

    const projectDream = readLatestProjectDream("maze");
    expect(projectDream).toContain("# Dream Deep Dive — maze");
    expect(projectDream).toContain("**Oracle KB**: offline");
    expect(projectDream).toContain("**Finish maze dream verification** [high, 1d]");
    expect(projectDream).toContain("Verify: Needs offline deep-dive followup");
    expect(projectDream).toContain("**Backfill maze checkbox** [high, 1d]");
    expect(projectDream).toContain("## Recent Commits");
    expect(projectDream).toContain("#77 Maze PR survives partial GitHub failure");
    expect(projectDream).not.toContain("Open Issues");
  });

  test("all mode still renders repo cards when momentum commands fail and filters repo-specific ARRA sections", async () => {
    scenario = "cards";
    throwMomentum = true;

    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● maze");
    expect(output).toContain("0/week");
    expect(output).toContain("Shipped maze fifth-pass card coverage");
    expect(output).toContain("Keep momentum commands resilient even when git exits");
    expect(output).toContain("Maze pattern signal survives retries");
    expect(output).not.toContain("BTC swing trade noise");
    expect(output).not.toContain("Old maze pattern should skip by age");
    expect(output).toContain("📊 1/1 active repos shown");

    const dream = readLatestDream();
    expect(dream).toContain("**Oracle KB**: connected");
    expect(dream).toContain("Maze runtime branch broke again");
    expect(dream).toContain("Finish maze all-mode card coverage");
    expect(dream).toContain("Shipped maze all-mode source coverage");
  });

  test("helper extraction handles dot-date filenames, What Happened fallback, and multiline section caps", () => {
    expect(
      extractTitle(
        "---\ntitle: short\n---",
        "/vault/maze-oracle/ψ/memory/logs/info/05.18_dream-thread.md",
      ),
    ).toBe("maze — dream thread");

    expect(
      extractSection(
        [
          "## Notes",
          "- one",
          "- two",
          "- three",
          "- four",
          "- five",
          "- six",
          "**Stop Here**",
          "- seven",
        ].join("\n"),
        "Notes",
      ),
    ).toBe("one - two - three - four - five");

    expect(
      extractSection(
        [
          "## What Happened",
          "- first useful line",
          "**Next Heading**",
          "- should not leak",
        ].join("\n"),
        "What Happened",
      ),
    ).toBe("first useful line");

    expect(
      extractDetail("title: meta\nWhat Happened: Maze branch finally reproduced cleanly during the fifth-pass offline dive"),
    ).toBe("Maze branch finally reproduced cleanly during the fifth-pass offline dive");
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${mazeRepo}\n${quietRepo}\n`;
  if (cmd.includes("log -1 --format='%s'")) return cmd.includes(quietRepo) ? "Quiet branch shelf" : "Maze branch work";
  if (cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes(quietRepo) ? "2026-04-10T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) return cmd.includes(mazeRepo) ? " M a\n M b\n M c\n M d\n M e\n M f\n" : "";
  if (cmd.includes("worktree list --porcelain")) {
    return cmd.includes(mazeRepo) ? `worktree ${mazeRepo}\n\nworktree ${mazeRepo}-agent\n` : `worktree ${quietRepo}\n`;
  }
  if (cmd.includes("log -15 --format")) {
    return "abc123 2026-05-17 Maze deep dive\ndef456 2026-05-16 Prep maze handoff";
  }
  if (cmd.includes("gh issue list")) return "not json";
  if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 77, title: "Maze PR survives partial GitHub failure", state: "OPEN" }]);
  if (cmd.includes("--since='7 days ago'") || cmd.includes("--since='30 days ago'")) {
    if (throwMomentum) throw new Error("momentum unavailable");
    return cmd.includes("7 days ago") ? "9\n" : "21\n";
  }
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";

  if (query === "test") {
    return { ok: scenario === "cards", json: async () => ({ results: [] }) } as Response;
  }

  if (scenario !== "cards") {
    return { ok: false, json: async () => ({ results: [] }) } as Response;
  }

  return { ok: true, json: async () => ({ results: resultsFor(query) }) } as Response;
}

function resultsFor(query: string) {
  if (query.includes("what went wrong")) {
    return [arra(mazeRepo, "learning", "# Maze runtime branch broke again\nSummary:\n- Project card coverage still needs isolation", 0.8, "2026-05-17_pain.md")];
  }
  if (query.includes("what should we build next")) {
    return [arra(mazeRepo, "retro", "Next Steps:\n- Finish maze all-mode card coverage", 0.8, "2026-05-17_plan.md")];
  }
  if (query.includes("what shipped")) {
    return [arra(mazeRepo, "retro", "Session Summary:\n- Shipped maze all-mode source coverage. Extra sentence after the first one.", 0.8, "2026-05-17_gain.md")];
  }
  if (query.includes("pattern appeared again")) {
    return [arra(mazeRepo, "learning", "# Maze memory pattern stayed useful\nSummary:\n- Reused the same safe mocks", 0.8, "2026-05-17_memory.md")];
  }
  if (query.includes("energy momentum") || query.includes("mode=vector")) {
    return [arra(mazeRepo, "retro", "# Calm momentum returned\nSummary:\n- The dream pass felt contained", 0.5, "2026-05-17_feeling.md")];
  }
  if (query.includes("maze shipped completed deployed merged")) {
    return [
      arra("/vault/other-oracle", "retro", "Session Summary:\n- Unrelated ship should be ignored", 0.8, "2026-05-17_other.md"),
      arra(mazeRepo, "retro", "Session Summary:\n- Shipped maze fifth-pass card coverage. Extra sentence after the first one.", 0.8, "2026-05-17_card-win.md"),
    ];
  }
  if (query.includes("maze friction improve problem could be better")) {
    return [arra(mazeRepo, "retro", "What Could Improve:\n- Keep momentum commands resilient even when git exits.\n## Next\n- not part of the section", 0.8, "2026-05-17_friction.md")];
  }
  if (query.includes("maze pattern lesson root cause always never")) {
    return [
      arra(mazeRepo, "learning", "# Maze pattern signal survives retries\nSummary:\n- Keep the clean title", 0.8, "2026-05-17_pattern.md"),
      arra(mazeRepo, "learning", "# BTC swing trade noise\nSummary:\n- Should be filtered", 0.8, "2026-05-17_noise.md"),
      arra(mazeRepo, "learning", "# Old maze pattern should skip by age\nSummary:\n- Too old to render", 0.8, "2026-03-01_oldpattern.md"),
    ];
  }
  return [];
}

function arra(repoPath: string, type: string, content: string, score: number, file: string) {
  return {
    type,
    content,
    score,
    source_file: join(repoPath, "ψ", "memory", file),
  };
}

function readLatestDream(): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams");
  const dreamFile = readdirSync(dreamsDir).find((name) => name.endsWith("_dream.md"));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}

function readLatestProjectDream(name: string): string {
  const dreamsDir = join(cwd, "ψ", "writing", "dreams", "project");
  const dreamFile = readdirSync(dreamsDir).find((entry) => entry.endsWith(`_${name}_deep.md`));
  expect(dreamFile).toBeDefined();
  return readFileSync(join(dreamsDir, dreamFile!), "utf8");
}
