import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test the VENDORED copy — that is what the runtime loads (~/.maw/plugins/team →
// src/vendor/mpr-plugins/team). #1976 originally landed in src/commands/plugins/team
// (core), which is tested but NOT dispatched, so `maw team up` was unreachable
// despite green tests. Guard the copy that actually ships.
import { parseTeamCharterText } from "../../src/vendor/mpr-plugins/team/team-charter";
import { classifyMember, engineCommand } from "../../src/vendor/mpr-plugins/team/team-liveness";
import { cmdTeamUp } from "../../src/vendor/mpr-plugins/team/team-up";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "maw-team-up-"));
  dirs.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".maw", "teams"), { recursive: true });
  writeFileSync(join(root, ".maw", "teams", "alpha.yaml"), `
name: alpha
session: charter-session
members:
  - role: coder-1
    engine: omx
    worktree: true
    queue:
      - q1
  - role: coder-10
    engine: claude48
  - role: oracle
    name: mawjs-oracle
    engine: codex
`, "utf-8");
  return root;
}

function fakeTmux(lines: string[]) {
  const calls: string[][] = [];
  const tmux = {
    run: async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "display-message") return "lead-session\n";
      if (args[0] === "list-panes") return lines.join("\n");
      return "";
    },
  };
  return { tmux, calls };
}

const config = { commands: {
  omx: "maw run omx",
  "omx-resume": "maw run omx-resume",
  claude48: "maw run claude48",
  "claude48-resume": "maw run claude48-resume",
  codex: "maw run codex",
  "codex-resume": "maw run codex-resume",
} } as any;

describe("maw team up (#1976)", () => {
  test("charter parser preserves session plus member engine/worktree/queue", () => {
    const charter = parseTeamCharterText(`
name: alpha
session: named-session
members:
  - role: coder
    name: mawjs-codex
    engine: omx
    worktree: true
    queue:
      - next
`);
    expect(charter.session).toBe("named-session");
    expect(charter.members[0]).toMatchObject({ role: "coder", name: "mawjs-codex", engine: "omx", worktree: true, queue: ["next"] });
  });


  test("semantic role adopts live window by charter member name", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "semantic.yaml"), `
name: semantic
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: true
  - role: implementer
    name: mawjs-codex
    engine: omx
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/wt/oracle|%1",
      "charter-session|mawjs-codex|codex|/wt/codex|%2",
    ]);
    const result = await cmdTeamUp("semantic", { status: true }, { cwd: root, tmux, loadConfigFn: () => config, logger: () => {} });
    expect(result.roster.map((m) => [m.role, m.windowIdentity, m.worktree, m.state])).toEqual([
      ["lead", "mawjs-oracle", "mawjs-oracle", "live"],
      ["implementer", "mawjs-codex", "mawjs-codex", "live"],
    ]);
  });

  test("role matching is anchored so coder-1 does not match coder-10", () => {
    const panes = [{ sessionName: "s", windowName: "repo-coder-10", command: "claude", path: "/x", paneId: "%1" }];
    expect(classifyMember({ role: "coder-1" }, panes, "s").state).toBe("missing");
    expect(classifyMember({ role: "coder-10" }, panes, "s").state).toBe("live");
  });

  test("status and dry-run are read-only classification modes", async () => {
    const root = tempRepo();
    const { tmux, calls } = fakeTmux([
      "charter-session|repo-coder-1|claude|/wt/coder-1|%1",
      "charter-session|repo-coder-10|zsh|/wt/coder-10|%10",
    ]);
    const wakes: any[] = [];
    const status = await cmdTeamUp("alpha", { status: true }, { cwd: root, tmux, loadConfigFn: () => config, cmdWakeFn: async (...a: any[]) => { wakes.push(a); return ""; }, logger: () => {} });
    expect(status.roster.map((m) => [m.role, m.state])).toEqual([["coder-1", "live"], ["coder-10", "dead"], ["oracle", "missing"]]);
    expect(calls.some((c) => c[0] === "send-keys" || c[0] === "kill-window")).toBe(false);
    expect(wakes).toHaveLength(0);

    const dry = await cmdTeamUp("alpha", { dryRun: true }, { cwd: root, tmux, loadConfigFn: () => config, cmdWakeFn: async (...a: any[]) => { wakes.push(a); return ""; }, logger: () => {} });
    expect(dry.output).toContain("No changes made");
    expect(dry.actions.map((a) => a.action)).toContain("would relaunch in place with resume");
    expect(wakes).toHaveLength(0);
  });

  test("dead resumes in place while missing uses fresh wake", async () => {
    const root = tempRepo();
    const { tmux, calls } = fakeTmux([
      "charter-session|repo-coder-1|claude|/wt/coder-1|%1",
      "charter-session|repo-coder-10|zsh|/wt/coder-10|%10",
    ]);
    const wakes: any[] = [];
    await cmdTeamUp("alpha", {}, { cwd: root, tmux, loadConfigFn: () => config, repoSlug: "Soul-Brews-Studio/maw-js", cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; }, sleep: async () => {}, logger: () => {} });
    expect(calls).toContainEqual(["send-keys", "-t", "%10", "maw run claude48-resume", "Enter"]);
    expect(wakes).toEqual([["Soul-Brews-Studio/maw-js", { wt: "mawjs-oracle", engine: "codex", session: "charter-session", repoPath: root }]]);
  });

  test("force kills existing windows and fresh-wakes all members", async () => {
    const root = tempRepo();
    const { tmux, calls } = fakeTmux([
      "charter-session|repo-coder-1|claude|/wt/coder-1|%1",
      "charter-session|repo-coder-10|zsh|/wt/coder-10|%10",
      "charter-session|mawjs-oracle|codex|/wt/oracle|%3",
    ]);
    const wakes: any[] = [];
    await cmdTeamUp("alpha", { force: true }, { cwd: root, tmux, loadConfigFn: () => config, cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; }, sleep: async () => {}, logger: () => {} });
    expect(calls.filter((c) => c[0] === "kill-window")).toHaveLength(3);
    expect(calls.some((c) => c.includes("omx-resume") || c.includes("claude48-resume") || c.includes("codex-resume"))).toBe(false);
    expect(wakes.map((w) => w[1].engine)).toEqual(["omx", "claude48", "codex"]);
  });

  test("engine command resolves resume key only when requested", () => {
    expect(engineCommand("omx", {}, config)).toBe("maw run omx");
    expect(engineCommand("omx", { resume: true }, config)).toBe("maw run omx-resume");
  });
});

// Regression guard for the integration miss: #1976 landed in core but the
// runtime dispatches the VENDORED plugin index, where `up` was an unknown
// subcommand. Assert the vendored handler routes `up` (usage path), NOT the
// "unknown subcommand" fallthrough. If this fails, the verb is unreachable
// from the installed binary even when cmdTeamUp itself is green.
describe("vendored team plugin routes `up` (#1976 integration)", () => {
  async function dispatch(args: string[]) {
    const handler = (await import("../../src/vendor/mpr-plugins/team/index.ts")).default;
    const out: string[] = [];
    const res = await handler({ source: "cli", args, writer: (...a: any[]) => out.push(a.map(String).join(" ")) } as any);
    return { res, out: out.join("\n") };
  }

  test("`team up` is a known subcommand", async () => {
    const { res } = await dispatch(["up"]);
    expect(res.error).not.toContain("unknown subcommand");
    expect(res.error).toBe("team required");
  });
});
