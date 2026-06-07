import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let cwd = "";
let focusRepo = "";
let twinRepo = "";
let staleRepo = "";
let logs: string[] = [];
let commands: string[] = [];

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
      name: "dream-more-session",
      windows: [
        { name: "focus", repo: "Soul-Brews-Studio/focus-oracle" },
        { name: "duplicate-focus", repo: "Soul-Brews-Studio/focus-oracle" },
      ],
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
} = await import("../../src/vendor/mpr-plugins/dream/impl.ts?more-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-more-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-more-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  focusRepo = createRepo(ownerRoot, "focus-oracle");
  twinRepo = createRepo(ownerRoot, "twin-oracle");
  staleRepo = createRepo(ownerRoot, "stale-oracle");
  logs = [];
  commands = [];
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

describe("dream impl additional isolated coverage", () => {
  test("project deep dive renders connections plus GitHub issue and PR lists", async () => {
    await cmdDream({ project: "focus" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: focus");
    expect(output).toContain("oracle KB connected");
    expect(output).toContain("PAIN — blocking or broken");
    expect(output).toContain("PLAN — next steps from retros");
    expect(output).toContain("MEMORY — patterns that repeat");
    expect(output).toContain("FEELING — emotional signals");
    expect(output).toContain("Connections");
    expect(output).toContain("has fix planned");
    expect(output).toContain("could prevent");
    expect(output).toContain("Recent commits");
    expect(output).toContain("abc123 2026-05-17 Rich dream commit");
    expect(output).toContain("Open issues");
    expect(output).toContain("#42 Rich dream issue");
    expect(output).toContain("Open PRs");
    expect(output).toContain("#77 Rich dream PR");

    const saved = readProjectDream("focus");
    expect(saved).toContain("# Dream Deep Dive — focus");
    expect(saved).toContain("## PAIN — blocking or broken");
    expect(saved).toContain("## Recent Commits");
    expect(saved).toContain("## Open Issues");
    expect(saved).toContain("## Open PRs");
    expect(commands.some((cmd) => cmd.includes("gh issue list --repo Soul-Brews-Studio/focus-oracle"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("gh pr list --repo Soul-Brews-Studio/focus-oracle"))).toBe(true);
  });

  test("between mode saves speculation risks and all-mode cards render wins, friction, and patterns", async () => {
    await cmdDream({ all: true, between: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● focus");
    expect(output).toContain("5/week");
    expect(output).toContain("Rich all-mode win sentence extends beyond fifteen chars");
    expect(output).toContain("Rich all-mode friction sentence extends beyond fifteen chars");
    expect(output).toContain("Rich reusable lesson pattern");
    expect(output).toContain("speculations →");
    expect(output).toContain("2/2 active repos shown");

    const dream = readLatestDream();
    expect(dream).toContain("**Scanned**: 3 repos | **Oracle KB**: connected");
    expect(dream).toContain("## Warnings");
    expect(dream).toContain("## Insights");
    expect(dream).toContain("Forgotten: 1 repos silent >90d");

    const speculation = readLatestSpeculation();
    expect(speculation).toContain("## Likely next session");
    expect(speculation).toContain("[HIGH] focus");
    expect(speculation).toContain("[MEDIUM] focus — Rich shared outage branch coverage fix");
    expect(speculation).toContain("## Risks");
    expect(speculation).toContain("focus — 7 uncommitted files");
  });

  test("speculate mode prints latest dream and speculation bullets while help prints usage", async () => {
    seedExistingDreamAndSpeculation();

    await cmdDream({ speculate: true } as never);
    let output = logs.join("\n");
    expect(output).toContain("Morpheus");
    expect(output).toContain("Latest dream:");
    expect(output).toContain("- dream bullet one");
    expect(output).toContain("Latest speculation:");
    expect(output).toContain("- speculation bullet one");

    logs = [];
    await cmdDream({ help: true } as never);
    output = logs.join("\n");
    expect(output).toContain("usage: maw dream [flags]");
    expect(output).toContain("--between");
  });

  test("exported helpers cover fallback extraction and filtering edge cases", () => {
    expect(extractTitle("---\ntitle: metadata\nSummary: Rich summary fallback title is long enough", "/tmp/unknown.md")).toBe("Rich summary fallback title is long enough");
    expect(extractTitle("short\nbody", "/tmp/github.com/Soul-Brews-Studio/focus-oracle/ψ/memory/logs/info/2026-05-17_file_name_title.md")).toBe("focus — file name title");
    expect(extractSection("Next Steps:\n1. First numbered step with enough content\n2. Second numbered step with enough content\n3. Third numbered step with enough content\n4. Fourth numbered step with enough content\n5. Fifth numbered step with enough content\n6. Sixth should be capped\n## Stop", "Next Steps")).not.toContain("Sixth should be capped");
    expect(extractDetail("What Happened:\n- Rich detail branch came from what happened section")).toContain("Rich detail branch");
    expect(extractDetail("---\ntags: x\ncreated: y\nThis fallback detail line is intentionally longer than thirty chars")).toContain("fallback detail line");
    expect(extractRepo("/tmp/repo/.claude/worktrees/agent-branch/ψ/memory/log.md")).toBe("repo");
    expect(extractRepo("/tmp/worktrees/agent-branch/ψ/memory/log.md")).toBe("tmp");
    expect(extractRepo("/tmp/no-psi/log.md")).toBe("unknown");
    expect(daysFromFile("/tmp/2026/05/16_note.md")).toBe(2);
    expect(daysFromFile("/tmp/no-date.md")).toBe(999);
    expect(isNoise("Buy BTC long position")).toBe(true);
    expect(shareKeywords("shared outage branch coverage", "shared outage branch plan", 3)).toBe(true);
    expect(shareKeywords("shared outage", "unrelated plan", 2)).toBe(false);
    expect(deduplicateItems([
      item("pain", "Duplicate branch coverage title", "focus"),
      item("pain", "Duplicate branch coverage title", "focus"),
      item("pain", "Duplicate branch coverage title", "twin"),
    ] as never)).toHaveLength(2);
  });
});

function createRepo(ownerRoot: string, dirName: string): string {
  const repoPath = join(ownerRoot, dirName);
  mkdirSync(join(repoPath, "ψ"), { recursive: true });
  return repoPath;
}

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${focusRepo}\n${twinRepo}\n${staleRepo}\n`;
  if (cmd.includes("log -1 --format='%s'")) {
    if (cmd.includes("twin-oracle")) return "Twin active commit";
    if (cmd.includes("stale-oracle")) return "Stale ancient commit";
    return "Focus active commit";
  }
  if (cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes("stale-oracle") ? "2025-12-01T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    return cmd.includes("focus-oracle") ? Array.from({ length: 7 }, (_, i) => ` M rich-${i}.ts`).join("\n") : "";
  }
  if (cmd.includes("worktree list --porcelain")) {
    const repo = cmd.includes("focus-oracle") ? focusRepo : cmd.includes("twin-oracle") ? twinRepo : staleRepo;
    return `worktree ${repo}\n`;
  }
  if (cmd.includes("log --oneline --since='7 days ago'")) return cmd.includes("focus-oracle") ? "5" : "2";
  if (cmd.includes("log --oneline --since='30 days ago'")) return cmd.includes("focus-oracle") ? "12" : "3";
  if (cmd.includes("log -15 --format")) return "abc123 2026-05-17 Rich dream commit";
  if (cmd.includes("gh issue list")) return JSON.stringify([{ number: 42, title: "Rich dream issue", state: "OPEN" }]);
  if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 77, title: "Rich dream PR", state: "OPEN" }]);
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const project = url.searchParams.get("project") ?? "";
  if (query === "test") return response(true, []);
  return response(true, resultsFor(query, project));
}

function resultsFor(query: string, project: string) {
  const repoDir = project.includes("twin-oracle") ? "twin-oracle" : "focus-oracle";
  const repoName = repoDir.replace(/-oracle$/, "");
  if (query.includes("what went wrong")) {
    return [arra(repoDir, "# Rich shared outage branch coverage\nSummary:\n- Rich pain detail stays visible", "2026-05-17_pain.md", 0.7)];
  }
  if (query.includes("what should we build next")) {
    return [arra(repoDir, "Next Steps:\n- Rich shared outage branch coverage fix", "2026-05-16_plan.md", 0.9)];
  }
  if (query.includes("what shipped") || query.includes("shipped completed deployed")) {
    return [arra(repoDir, "Session Summary:\nRich all-mode win sentence extends beyond fifteen chars. More text.", "2026-05-15_gain.md", 0.8)];
  }
  if (query.includes("pattern appeared again")) {
    return [arra(repoDir, `# Rich shared outage branch coverage ${repoName}\nSummary:\n- Memory prevents this pain`, "2026-05-14_memory.md", 0.8)];
  }
  if (query.includes("energy momentum")) {
    return [arra(repoDir, "# Rich emotional breakthrough branch\nSummary:\n- Feeling branch detail", "2026-05-13_feeling.md", 0.5)];
  }
  if (query.includes("friction improve")) {
    return [arra(repoDir, "What Could Improve:\nRich all-mode friction sentence extends beyond fifteen chars. More text.", "2026-05-12_friction.md", 0.8)];
  }
  if (query.includes("pattern lesson root cause")) {
    return [arra(repoDir, "# Rich reusable lesson pattern\nSummary:\n- Reuse it", "2026-05-11_pattern.md", 0.8)];
  }
  if (query.includes("next steps should build")) {
    return [arra("focus-oracle", "Next Steps:\n- Rich forgotten plan item needs completion", "2026-04-25_forgotten.md", 0.8)];
  }
  if (query.includes("keeps happening same bug")) {
    return [arra("focus-oracle", "# Rich recurring warning branch\nSummary:\n- Still active", "2026-05-16_warning.md", 0.8)];
  }
  return [];
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

function readProjectDream(repoName: string): string {
  const dir = join(cwd, "ψ", "writing", "dreams", "project");
  const file = readdirSync(dir).find((entry) => entry.endsWith(`_${repoName}_deep.md`));
  expect(file).toBeDefined();
  return readFileSync(join(dir, file!), "utf8");
}

function readLatestDream(): string {
  const dir = join(cwd, "ψ", "writing", "dreams");
  const file = readdirSync(dir).filter((entry) => entry.endsWith("_dream.md")).sort().at(-1);
  expect(file).toBeDefined();
  return readFileSync(join(dir, file!), "utf8");
}

function readLatestSpeculation(): string {
  const dir = join(cwd, "ψ", "memory", "morpheus");
  const file = readdirSync(dir).filter((entry) => entry.endsWith("_speculations.md")).sort().at(-1);
  expect(file).toBeDefined();
  return readFileSync(join(dir, file!), "utf8");
}

function seedExistingDreamAndSpeculation(): void {
  const dreamDir = join(cwd, "ψ", "writing", "dreams");
  const specDir = join(cwd, "ψ", "memory", "morpheus");
  mkdirSync(dreamDir, { recursive: true });
  mkdirSync(specDir, { recursive: true });
  const dream = join(dreamDir, "2026-05-17_existing_dream.md");
  const spec = join(specDir, "2026-05-17_existing_speculations.md");
  writeFileSync(dream, "# Dream\n- dream bullet one\n- dream bullet two\n");
  writeFileSync(spec, "# Morpheus\n- speculation bullet one\n- speculation bullet two\n");
  const recent = new Date("2026-05-17T00:00:00.000Z");
  utimesSync(dream, recent, recent);
  utimesSync(spec, recent, recent);
}

function item(category: string, title: string, project: string) {
  return { category, title, project, detail: "", source: "/tmp", confidence: "high", daysAgo: 0 };
}
