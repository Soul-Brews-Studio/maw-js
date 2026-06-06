import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Test the VENDORED copy — that is what the runtime loads (~/.maw/plugins/team →
// src/vendor/mpr-plugins/team). #1976 originally landed in src/commands/plugins/team
// (core), which is tested but NOT dispatched, so `maw team up` was unreachable
// despite green tests. Guard the copy that actually ships.
import { parseTeamCharterText } from "../../src/vendor/mpr-plugins/team/team-charter";
import { classifyMember, engineCommand, memberWakeOptions, memberWakeTarget, resolveCharterPath } from "../../src/vendor/mpr-plugins/team/team-liveness";
import { cmdTeamUp } from "../../src/vendor/mpr-plugins/team/team-up";
import { cmdTeamDown, TEAM_LIFECYCLE_GUARD_WINDOW } from "../../src/vendor/mpr-plugins/team/team-down";

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
    node: m5
    channels: true
    queue:
      - next
`);
    expect(charter.session).toBe("named-session");
    expect(charter.members[0]).toMatchObject({ role: "coder", name: "mawjs-codex", engine: "omx", worktree: true, node: "m5", channels: true, queue: ["next"] });
  });

  test("node-guarded members on another node are skipped, not reported missing or woken", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "nodes.yaml"), `
name: nodes
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
  - role: bridge
    name: mawjs-oss-world
    engine: claude
    node: oracle-world
    channels: true
`, "utf-8");
    const { tmux, calls } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/wt/oracle|%1",
    ]);
    const wakes: any[] = [];

    const status = await cmdTeamUp("nodes", { status: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      logger: () => {},
    });

    expect(status.roster.map((m) => [m.role, m.state, m.skipReason])).toEqual([
      ["lead", "live", undefined],
      ["bridge", "skipped", "other node: oracle-world"],
    ]);
    expect(status.output).toContain("bridge\tclaude\tskipped\tskip (other node: oracle-world)");
    expect(status.output).not.toContain("bridge\tclaude\tmissing");
    expect(wakes).toHaveLength(0);

    await cmdTeamUp("nodes", { force: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      sleep: async () => {},
      logger: () => {},
    });
    expect(wakes.map((w) => w[1].wt)).toEqual(["mawjs-oracle"]);
    expect(calls.filter((c) => c[0] === "kill-window" && !c.join(" ").includes(TEAM_LIFECYCLE_GUARD_WINDOW))).toHaveLength(1);
  });

  test("same-node channels member is wakeable with --channels and fresh wake passes channels", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "bridge.yaml"), `
name: bridge
session: charter-session
members:
  - role: bridge
    name: mawjs-oss-world
    engine: claude
    node: oracle-world
    channels: true
`, "utf-8");
    const { tmux } = fakeTmux([]);
    const wakes: any[] = [];

    const status = await cmdTeamUp("bridge", { status: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "oracle-world" }),
      logger: () => {},
    });
    expect(status.roster.map((m) => [m.role, m.state])).toEqual([["bridge", "missing"]]);
    expect(status.output).toContain("wakeable --wt mawjs-oss-world -e claude --session charter-session --channels");

    const dry = await cmdTeamUp("bridge", { dryRun: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "oracle-world" }),
      logger: () => {},
    });
    expect(dry.output).toContain("would fresh wake --wt mawjs-oss-world -e claude --session charter-session --channels");

    await cmdTeamUp("bridge", {}, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "oracle-world" }),
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      sleep: async () => {},
      logger: () => {},
    });
    expect(wakes).toEqual([[expect.any(String), { wt: "mawjs-oss-world", engine: "claude", session: "charter-session", repoPath: root, channels: true }]]);
  });




  test("node yaml charter is resolved from config.node and new agents map defaults to worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-yaml-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw"), { recursive: true });
    writeFileSync(join(root, ".maw", "m5.yaml"), `
name: m5-team
project: soul-brews-studio/maw-js
discord: mawjs
agents:
  codex:
    engine: omx
    prompt: inline hello
  oss-world:
    engine: claude
    discord: false
`, "utf-8");
    const { tmux } = fakeTmux([]);

    expect(resolveCharterPath("missing-team", root, "m5")).toBe(join(root, ".maw", "m5.yaml"));

    const status = await cmdTeamUp("missing-team", { status: true, session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      logger: () => {},
    });

    expect(status.roster.map((m) => [m.role, m.engine, m.worktree, m.state])).toEqual([
      ["codex", "omx", "codex", "missing"],
      ["oss-world", "claude", "oss-world", "missing"],
    ]);
    expect(status.output).toContain("codex\tomx\tmissing\twakeable --wt codex -e omx --session charter-session --channels");
    expect(status.output).toContain("oss-world\tclaude\tmissing\twakeable --wt oss-world -e claude --session charter-session");
    expect(status.output).not.toContain("oss-world\tclaude\tmissing\twakeable --wt oss-world -e claude --session charter-session --channels");
  });

  test("team up wakes charter.project and primes inline plus file-ref prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-prompt-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw"), { recursive: true });
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "claude48.md"), "file prompt\n", "utf-8");
    writeFileSync(join(root, ".maw", "m5.yaml"), `
name: m5-team
project: soul-brews-studio/maw-js
discord: mawjs
agents:
  codex:
    engine: omx
    prompt: |
      inline prompt
  claude48:
    engine: claude48
    prompt: ./prompts/claude48.md
`, "utf-8");
    const { tmux } = fakeTmux([]);
    const wakes: any[] = [];
    const sends: any[] = [];

    await cmdTeamUp("any", { session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      sleep: async () => {},
      logger: () => {},
    });

    expect(wakes).toEqual([
      ["soul-brews-studio/maw-js", { wt: "codex", engine: "omx", session: "charter-session", repoPath: root, channels: true }],
      ["soul-brews-studio/maw-js", { wt: "claude48", engine: "claude48", session: "charter-session", repoPath: root, channels: true }],
    ]);
    expect(sends).toEqual([
      ["codex", "inline prompt", false],
      ["claude48", "file prompt", false],
    ]);
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
    expect(calls.filter((c) => c[0] === "kill-window" && !c.join(" ").includes(TEAM_LIFECYCLE_GUARD_WINDOW))).toHaveLength(3);
    expect(calls.some((c) => c.includes("omx-resume") || c.includes("claude48-resume") || c.includes("codex-resume"))).toBe(false);
    expect(wakes.map((w) => w[1].engine)).toEqual(["omx", "claude48", "codex"]);
  });


  test("--only skips members outside the selected role/name/worktree set", async () => {
    const root = tempRepo();
    const { tmux } = fakeTmux([]);
    const wakes: any[] = [];

    const status = await cmdTeamUp("alpha", { status: true, only: ["coder-1"] }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      logger: () => {},
    });
    expect(status.roster.map((m) => [m.role, m.state, m.skipReason])).toEqual([
      ["coder-1", "missing", undefined],
      ["coder-10", "skipped", "outside --only"],
      ["oracle", "skipped", "outside --only"],
    ]);

    await cmdTeamUp("alpha", { only: ["coder-1"] }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      sleep: async () => {},
      logger: () => {},
    });
    expect(wakes.map((w) => w[1].wt)).toEqual(["coder-1"]);
  });


  test("worktree:false lead adopts base oracle window and fresh wake avoids --wt double-prefix", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "lead.yaml"), `
name: lead
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: false
`, "utf-8");

    const live = fakeTmux(["charter-session|mawjs|claude|/repo|%1"]);
    const adopted = await cmdTeamUp("lead", { status: true }, { cwd: root, tmux: live.tmux, repoSlug: "Soul-Brews-Studio/mawjs-oracle", loadConfigFn: () => config, logger: () => {} });
    expect(adopted.roster.map((m) => [m.role, m.windowIdentity, m.state, m.pane?.windowName])).toEqual([["lead", "mawjs-oracle", "live", "mawjs"]]);

    const missing = fakeTmux([]);
    const status = await cmdTeamUp("lead", { status: true }, { cwd: root, tmux: missing.tmux, repoSlug: "Soul-Brews-Studio/mawjs-oracle", loadConfigFn: () => config, logger: () => {} });
    expect(status.output).toContain("lead\tclaude\tmissing\twakeable mawjs-oracle -e claude --session charter-session");
    expect(status.output).not.toContain("--wt mawjs-oracle");

    expect(memberWakeTarget("Soul-Brews-Studio/mawjs-oracle", status.roster[0].member)).toBe("mawjs-oracle");
    expect(memberWakeOptions(status.roster[0].member, { engine: "claude", session: "charter-session", repoPath: root })).toEqual({ engine: "claude", session: "charter-session", repoPath: root });
  });

  test("--session overrides current tmux session for headless/ssh-safe targeting", async () => {
    const root = tempRepo();
    const { tmux } = fakeTmux([]);
    const result = await cmdTeamUp("alpha", { status: true, session: "01-mawjs" }, { cwd: root, tmux, loadConfigFn: () => config, logger: () => {} });
    expect(result.session).toBe("01-mawjs");
    expect(result.output).toContain("team up: alpha (01-mawjs)");
    expect(result.warnings).toContain("current tmux session 'lead-session' differs from --session '01-mawjs'; targeting explicit session");
  });

  test("engine command resolves resume key only when requested", () => {
    expect(engineCommand("omx", {}, config)).toBe("maw run omx");
    expect(engineCommand("omx", { resume: true }, config)).toBe("maw run omx-resume");
  });
});

describe("maw team down (#2002)", () => {
  test("status keeps lead, plans maw done for live workers, and skips off-node members", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "down.yaml"), `
name: down
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: false
  - role: implementer
    name: codex
    engine: omx
    worktree: true
  - role: reviewer
    name: coder-1
    engine: claude48
    worktree: true
  - role: bridge
    name: oss-world
    engine: claude
    node: oracle-world
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/repo|%1",
      "charter-session|mawjs-codex|codex|/wt/codex|%2",
      "charter-session|mawjs-coder-1|claude|/wt/coder-1|%3",
    ]);
    const doneCalls: any[] = [];

    const result = await cmdTeamDown("down", { status: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });

    expect(result.actions.map((a) => [a.role, a.action, a.target])).toEqual([
      ["lead", "keep (lead)", undefined],
      ["implementer", "would maw done mawjs-codex", "mawjs-codex"],
      ["reviewer", "would maw done mawjs-coder-1", "mawjs-coder-1"],
      ["bridge", "keep (other node: oracle-world)", undefined],
    ]);
    expect(doneCalls).toHaveLength(0);
  });

  test("default down keeps role bridge members in-session", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "down.yaml"), `
name: down
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: false
  - role: implementer
    name: codex
    engine: omx
    worktree: true
  - role: reviewer
    name: coder-1
    engine: claude48
    worktree: true
  - role: bridge
    name: bridge-oracle
    engine: claude
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/repo|%1",
      "charter-session|mawjs-codex|codex|/wt/codex|%2",
      "charter-session|mawjs-coder-1|claude|/wt/coder-1|%3",
      "charter-session|mawjs-bridge-oracle|claude|/wt/bridge-oracle|%4",
    ]);
    const doneCalls: any[] = [];

    await cmdTeamDown("down", {}, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });

    expect(doneCalls).toEqual([[
      "mawjs-codex",
      { sessionName: "charter-session" },
    ], [
      "mawjs-coder-1",
      { sessionName: "charter-session" },
    ]]);

  });

  test("down executes done for selected live workers, supports --keep and --all", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "down.yaml"), `
name: down
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: false
  - role: implementer
    name: codex
    engine: omx
    worktree: true
  - role: reviewer
    name: coder-1
    engine: claude48
    worktree: true
`, "utf-8");
    const { tmux, calls } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/repo|%1",
      "charter-session|mawjs-codex|codex|/wt/codex|%2",
      "charter-session|mawjs-coder-1|claude|/wt/coder-1|%3",
    ]);
    const doneCalls: any[] = [];

    await cmdTeamDown("down", { keep: ["coder-1"] }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });
    expect(doneCalls).toEqual([["mawjs-codex", { sessionName: "charter-session" }]]);

    doneCalls.length = 0;
    await cmdTeamDown("down", { all: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });
    expect(doneCalls.map((c) => c[0])).toEqual(["mawjs-oracle", "mawjs-codex", "mawjs-coder-1"]);
    expect(calls).toContainEqual(["new-window", "-d", "-t", "charter-session:", "-n", TEAM_LIFECYCLE_GUARD_WINDOW]);
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

  test("`team down` is a known subcommand", async () => {
    const { res } = await dispatch(["down"]);
    expect(res.error).not.toContain("unknown subcommand");
    expect(res.error).toBe("team required");
  });
});
