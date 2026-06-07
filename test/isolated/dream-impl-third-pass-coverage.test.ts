import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqRoot = "";
let activeRepo = "";
let staleRepo = "";
let cwd = "";
let logs: string[] = [];
let commands: string[] = [];
let ghqThrows = false;

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
      name: "active-session",
      windows: [
        { name: "main", repo: "Soul-Brews-Studio/active-oracle" },
        { name: "missing", repo: "Soul-Brews-Studio/missing-oracle" },
      ],
    },
  ],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?third-pass-coverage");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-third-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-third-cwd-"));
  const ownerRoot = join(ghqRoot, "github.com", "Soul-Brews-Studio");
  activeRepo = join(ownerRoot, "active-oracle");
  staleRepo = join(ownerRoot, "stale-oracle");
  mkdirSync(join(activeRepo, "ψ"), { recursive: true });
  mkdirSync(join(staleRepo, "ψ"), { recursive: true });
  process.chdir(cwd);
  logs = [];
  commands = [];
  ghqThrows = false;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  Date.now = () => new Date("2026-05-18T00:00:00.000Z").getTime();
  globalThis.fetch = async () => { throw new Error("ARRA offline in third-pass coverage test"); };
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  globalThis.fetch = original.fetch;
  Date.now = original.dateNow;
  rmSync(ghqRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("dream command third-pass branch coverage", () => {
  test("falls back to a git-only briefing when ARRA is offline", async () => {
    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream");
    expect(output).toContain("PAIN");
    expect(output).toContain("📊 1 active | 1 stale");
    expect(output).toContain("saved →");
    expect(output).not.toContain("Forgotten");
    expect(output).not.toContain("Watch Out");

    const dreamFile = readdirSync(join(cwd, "ψ", "writing", "dreams")).find(name => name.endsWith("_dream.md"));
    expect(dreamFile).toBeDefined();
    const savedDream = readFileSync(join(cwd, "ψ", "writing", "dreams", dreamFile!), "utf8");
    expect(savedDream).toContain("**Oracle KB**: offline");
    expect(savedDream).toContain("active — 6 uncommitted files");
    expect(savedDream).toContain("stale — silent 168d");
    expect(commands.some(cmd => cmd === "ghq list -p 2>/dev/null")).toBe(true);
  });

  test("reports known projects without saving when a project lookup misses", async () => {
    ghqThrows = true;

    await cmdDream({ project: "ghost" } as never);

    const output = logs.join("\n");
    expect(output).toContain('project "ghost" not found');
    expect(output).toContain("known: active");
    expect(output).not.toContain("saved →");
    expect(() => readdirSync(join(cwd, "ψ", "writing", "dreams", "project"))).toThrow();
  });
});

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") {
    if (ghqThrows) throw new Error("ghq unavailable");
    return `${activeRepo}\n${staleRepo}\n`;
  }
  if (cmd.includes("log -1 --format='%s'")) return cmd.includes(staleRepo) ? "Dormant baseline" : "Active branch work";
  if (cmd.includes("log -1 --format='%ct'")) {
    const date = cmd.includes(staleRepo) ? "2025-12-01T00:00:00.000Z" : "2026-05-17T00:00:00.000Z";
    return String(Math.floor(new Date(date).getTime() / 1000));
  }
  if (cmd.includes("status --porcelain")) return cmd.includes(activeRepo) ? " M a\n M b\n M c\n M d\n M e\n M f\n" : "";
  if (cmd.includes("worktree list --porcelain")) return `worktree ${cmd.includes(staleRepo) ? staleRepo : activeRepo}\n`;
  return "";
}
