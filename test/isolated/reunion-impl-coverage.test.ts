import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Session = { name: string; windows: Array<{ name: string }> };

let sessions: Session[] = [];
let cwdByTarget = new Map<string, string>();
let gitRootByCwd = new Map<string, string | Error>();
let hostExecThrowsForTmux = false;

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  hostExec: async (cmd: string) => {
    if (cmd.startsWith("tmux display-message")) {
      if (hostExecThrowsForTmux) throw new Error("tmux failed");
      const target = cmd.match(/-t '([^']+)'/)?.[1] ?? "__current__";
      return cwdByTarget.get(target) ?? cwdByTarget.get("__current__") ?? "";
    }
    const cwd = cmd.match(/git -C '([^']+)'/)?.[1];
    const result = cwd ? gitRootByCwd.get(cwd) : undefined;
    if (result instanceof Error) throw result;
    return result ?? ".git";
  },
}));

const reunionMod = await import("../../src/vendor/mpr-plugins/reunion/impl.ts?reunion-impl-coverage");
const doneReunionMod = await import("../../src/vendor/mpr-plugins/done/internal/reunion-impl.ts?done-reunion-impl-coverage");

const capture = async (fn: () => Promise<unknown>) => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = origLog;
  }
};

const modules = [
  ["reunion", reunionMod.cmdReunion],
  ["done reunion", doneReunionMod.cmdReunion],
] as const;

describe.each(modules)("%s implementation coverage", (_label, cmdReunion) => {
  let dir: string;
  let mainRoot: string;
  let worktree: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-reunion-"));
    mainRoot = join(dir, "main-oracle");
    worktree = join(dir, "worktree");
    mkdirSync(mainRoot, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    sessions = [];
    cwdByTarget = new Map([["__current__", worktree]]);
    gitRootByCwd = new Map([[worktree, join(mainRoot, ".git")]]);
    hostExecThrowsForTmux = false;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("syncs new ψ memory files from current worktree to main without overwriting", async () => {
    mkdirSync(join(worktree, "ψ", "memory", "learnings"), { recursive: true });
    mkdirSync(join(worktree, "ψ", "memory", "traces", "nested"), { recursive: true });
    mkdirSync(join(mainRoot, "ψ", "memory", "learnings"), { recursive: true });
    writeFileSync(join(worktree, "ψ", "memory", "learnings", "new.md"), "new", "utf-8");
    writeFileSync(join(worktree, "ψ", "memory", "learnings", "existing.md"), "worktree", "utf-8");
    writeFileSync(join(mainRoot, "ψ", "memory", "learnings", "existing.md"), "main", "utf-8");
    writeFileSync(join(worktree, "ψ", "memory", "traces", "nested", "trace.md"), "trace", "utf-8");

    const { result, logs } = await capture(() => cmdReunion());

    expect(result).toMatchObject({ mainRoot, total: 2 });
    expect(readFileSync(join(mainRoot, "ψ", "memory", "learnings", "new.md"), "utf-8")).toBe("new");
    expect(readFileSync(join(mainRoot, "ψ", "memory", "learnings", "existing.md"), "utf-8")).toBe("main");
    expect(readFileSync(join(mainRoot, "ψ", "memory", "traces", "nested", "trace.md"), "utf-8")).toBe("trace");
    expect(logs.join("\n")).toContain("reunion: synced 1 learnings, 1 traces");
  });

  test("resolves a named tmux window case-insensitively and reports nothing-new", async () => {
    sessions = [{ name: "77-mawjs", windows: [{ name: "Work" }] }];
    cwdByTarget.set("77-mawjs:Work", worktree);
    mkdirSync(join(worktree, "ψ", "memory", "learnings"), { recursive: true });

    const { result, logs } = await capture(() => cmdReunion("work"));

    expect(result).toMatchObject({ mainRoot, total: 0, synced: {} });
    expect(logs.join("\n")).toContain("nothing new to sync");
  });

  test("returns null for missing window, tmux cwd failures, missing ψ, and main-repo cwd", async () => {
    sessions = [{ name: "77-mawjs", windows: [{ name: "main" }] }];
    expect((await capture(() => cmdReunion("ghost"))).result).toBeNull();

    hostExecThrowsForTmux = true;
    expect((await capture(() => cmdReunion("main"))).result).toBeNull();
    hostExecThrowsForTmux = false;

    expect((await capture(() => cmdReunion())).result).toBeNull();

    mkdirSync(join(worktree, "ψ"), { recursive: true });
    gitRootByCwd.set(worktree, ".git");
    expect((await capture(() => cmdReunion())).result).toBeNull();
  });

  test("returns null when git common-dir lookup fails", async () => {
    mkdirSync(join(worktree, "ψ"), { recursive: true });
    gitRootByCwd.set(worktree, new Error("not a git repo"));

    const { result, logs } = await capture(() => cmdReunion());

    expect(result).toBeNull();
    expect(logs.join("\n")).toContain("not a worktree");
  });

  test("ignores unreadable source trees and copy failures without failing the command", async () => {
    mkdirSync(join(worktree, "ψ", "memory", "learnings"), { recursive: true });
    writeFileSync(join(worktree, "ψ", "memory", "learnings", "file.md"), "content", "utf-8");
    mkdirSync(join(mainRoot, "ψ", "memory", "learnings", "file.md"), { recursive: true });

    const { result } = await capture(() => cmdReunion());

    expect(result).toMatchObject({ mainRoot, total: 0 });
    expect(existsSync(join(mainRoot, "ψ", "memory", "learnings", "file.md"))).toBe(true);
  });
});
