import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let activeRepo = "";
let staleRepo = "";
let cwd = "";
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
    { name: "active", windows: [{ name: "main", repo: "Soul-Brews-Studio/active-oracle" }] },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?second-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  activeRepo = join(ownerRoot, "active-oracle");
  staleRepo = join(ownerRoot, "stale-oracle");
  mkdirSync(join(activeRepo, "ψ", "inbox", "handoff"), { recursive: true });
  mkdirSync(join(staleRepo, "ψ"), { recursive: true });
  writeFileSync(
    join(activeRepo, "ψ", "inbox", "handoff", "2026-05-17_handoff.md"),
    "| Priority | Item | Context |\n| --- | --- | --- |\n| Verify | Confirm dream coverage LCOV | Blocks beta |\n- [ ] Backfill second pass coverage\n",
  );
  process.chdir(cwd);
  logs = [];
  commands = [];
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

describe("dream command second-pass runtime coverage", () => {
  test("connected briefing scans repos, folds ARRA findings, handoffs, forgotten work, warnings, and speculations", async () => {
    await cmdDream({ between: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("PAIN");
    expect(output).toContain("GAIN");
    expect(output).toContain("Forgotten");
    expect(output).toContain("Watch Out");
    expect(output).toContain("saved →");
    expect(output).toContain("speculations →");

    const dreamsDir = join(cwd, "ψ", "writing", "dreams");
    const dreamFile = readdirSync(dreamsDir).find(name => name.endsWith("_dream.md"));
    expect(dreamFile).toBeDefined();
    const savedDream = readFileSync(join(dreamsDir, dreamFile!), "utf8");
    expect(savedDream).toContain("**Oracle KB**: connected");
    expect(savedDream).toContain("Plugin coverage seam keeps failing");
    expect(savedDream).toContain("Forgotten");
    expect(savedDream).toContain("Warnings");
    expect(savedDream).toContain("Insights");

    const speculationDir = join(cwd, "ψ", "memory", "morpheus");
    expect(readdirSync(speculationDir).some(name => name.endsWith("_speculations.md"))).toBe(true);
    expect(commands.some(cmd => cmd === "ghq list -p 2>/dev/null")).toBe(true);
  });

  test("project deep dive renders connections, git log, GitHub sections, and saves the project dream", async () => {
    await cmdDream({ project: "active" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream — deep dive: active");
    expect(output).toContain("Connections");
    expect(output).toContain("Recent commits");
    expect(output).toContain("Open issues");
    expect(output).toContain("Open PRs");
    expect(output).toContain("saved →");

    const projectDir = join(cwd, "ψ", "writing", "dreams", "project");
    const projectFile = readdirSync(projectDir).find(name => name.endsWith("_active_deep.md"));
    expect(projectFile).toBeDefined();
    const savedProject = readFileSync(join(projectDir, projectFile!), "utf8");
    expect(savedProject).toContain("# Dream Deep Dive — active");
    expect(savedProject).toContain("## Recent Commits");
    expect(savedProject).toContain("#12 Track dream findings");
    expect(savedProject).toContain("#34 Merge dream coverage");
  });

  test("all mode renders per-project cards with momentum, wins, friction, and patterns", async () => {
    await cmdDream({ all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("● active");
    expect(output).toContain("3/week");
    expect(output).toContain("Completed active project smoke coverage");
    expect(output).toContain("Keep command mocks explicit");
    expect(output).toContain("Active mock pattern needs isolation");
    expect(output).toContain("→ maw workon active");
    expect(output).toContain("1/1 active repos shown");

    const dreamsDir = join(cwd, "ψ", "writing", "dreams");
    const dreamFile = readdirSync(dreamsDir).find(name => name.endsWith("_dream.md"));
    expect(dreamFile).toBeDefined();
    const savedDream = readFileSync(join(dreamsDir, dreamFile!), "utf8");
    expect(savedDream).toContain("## PAIN — blocking or broken");
    expect(savedDream).toContain("## GAIN — shipped this period");
  });

  test("speculate and help modes print existing artifacts and usage text", async () => {
    const dreamsDir = join(cwd, "ψ", "writing", "dreams");
    const morpheusDir = join(cwd, "ψ", "memory", "morpheus");
    mkdirSync(dreamsDir, { recursive: true });
    mkdirSync(morpheusDir, { recursive: true });
    writeFileSync(join(dreamsDir, "2026-05-17_dream.md"), "# Dream\n- Keep coverage stable\n- Finish wake-cmd gaps\n");
    writeFileSync(join(morpheusDir, "2026-05-17_speculations.md"), "# Speculation\n- Watch server routes\n- Review messages index\n");

    await cmdDream({ speculate: true } as never);
    await cmdDream({ help: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("Morpheus");
    expect(output).toContain("Latest dream:");
    expect(output).toContain("Latest speculation:");
    expect(output).toContain("- Keep coverage stable");
    expect(output).toContain("- Watch server routes");
    expect(output).toContain("usage: maw dream [flags]");
    expect(output).toContain("maw dream --all");
    expect(output).toContain("maw dream --speculate");
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") return `${activeRepo}\n${staleRepo}\n`;
  if (cmd.includes("log -1 --format='%s'")) return cmd.includes(staleRepo) ? "Dormant baseline" : "Ship dream coverage";
  if (cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes(staleRepo) ? "2025-12-01T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) return cmd.includes(activeRepo) ? " M a\n M b\n M c\n M d\n M e\n M f\n" : "";
  if (cmd.includes("worktree list --porcelain")) {
    if (cmd.includes(activeRepo)) return `worktree ${activeRepo}\n\nworktree ${activeRepo}-feature\n`;
    return `worktree ${staleRepo}\n`;
  }
  if (cmd.includes("log -15 --format")) return "abc123 2026-05-17 Ship dream coverage\ndef456 2026-05-16 Add handoff parser";
  if (cmd.includes("gh issue list")) return JSON.stringify([{ number: 12, title: "Track dream findings", state: "OPEN" }]);
  if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 34, title: "Merge dream coverage", state: "OPEN" }]);
  if (cmd.includes("--since='7 days ago'")) return "3\n";
  if (cmd.includes("--since='30 days ago'")) return "8\n";
  return "";
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const mode = url.searchParams.get("mode") ?? "";
  const results = resultsFor(query, type, mode);
  return { ok: true, json: async () => ({ results }) } as Response;
}

function resultsFor(query: string, type: string, mode: string) {
  if (query === "test") return [];
  if (query.includes("what went wrong")) {
    return [arra("learning", "# Plugin coverage seam keeps failing\nSummary:\n- Mocked command flow needs stable branch coverage", 0.8, "2026-05-17_learning.md")];
  }
  if (query.includes("what should we build next")) {
    return [arra("retro", "Next Steps:\n- Fix plugin coverage seam with isolated tests", 0.7, "2026-05-10_retro.md")];
  }
  if (query.includes("what shipped")) {
    return [arra("retro", "Session Summary:\n- Shipped focused isolated coverage for dream runtime paths.", 0.9, "2026-05-12_retro.md")];
  }
  if (query.includes("pattern appeared again")) {
    return [arra("learning", "# Same plugin coverage seam repeated\nSummary:\n- Keep command mocks in isolated tests", 0.9, "2026-05-16_learning.md")];
  }
  if (query.includes("energy momentum") || mode === "vector") {
    return [arra("retro", "# Momentum returned after green tests\nSummary:\n- The coverage pass felt safe and focused", 0.5, "2026-05-16_feeling.md")];
  }
  if (query.includes("next steps should build")) {
    return [
      arra("retro", "Next Steps:\n- Finish dream plugin command coverage\n- Finish dream plugin command coverage duplicate\n- done already shipped\n- continue as required", 0.6, "2026-04-25_retro.md"),
    ];
  }
  if (query.includes("keeps happening same bug")) {
    return [
      arra("learning", "# Plugin coverage seam keeps happening\nSummary:\n- Same mock boundary regressed", 0.8, "2026-05-15_warning.md"),
      arra("learning", "# Plugin coverage seam keeps happening again\nSummary:\n- Duplicate warning should collapse", 0.8, "2026-05-15_warning_2.md"),
    ];
  }
  if (query.includes("shipped completed deployed")) {
    return [arra("retro", "Session Summary:\n- Completed active project smoke coverage. More details after sentence.", 0.8, "2026-05-14_card.md")];
  }
  if (query.includes("friction improve")) {
    return [arra("retro", "What Could Improve:\n- Keep command mocks explicit so failures explain the branch.", 0.8, "2026-05-14_friction.md")];
  }
  if (query.includes("pattern lesson")) {
    return [arra("learning", "# Active mock pattern needs isolation", 0.8, "2026-05-14_pattern.md")];
  }
  return type ? [] : [];
}

function arra(type: string, content: string, score: number, file: string) {
  const source_file = join(activeRepo, "ψ", "memory", file);
  if (!existsSync(join(activeRepo, "ψ", "memory"))) mkdirSync(join(activeRepo, "ψ", "memory"), { recursive: true });
  return { type, content, score, source_file };
}
