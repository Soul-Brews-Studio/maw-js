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
import * as commandTeamLiveness from "../../src/commands/plugins/team/team-liveness";
import * as vendorTeamLiveness from "../../src/vendor/mpr-plugins/team/team-liveness";
import { cmdTeamUp, quickCharter, formatTeamInboxHandoff } from "../../src/vendor/mpr-plugins/team/team-up";
import { cmdTeamDown, TEAM_LIFECYCLE_GUARD_WINDOW } from "../../src/vendor/mpr-plugins/team/team-down";
import { cmdTeamApply } from "../../src/vendor/mpr-plugins/team/team-apply";
import { _setDirs, TEAMS_DIR, TASKS_DIR, readUnreadTeamMemberInbox, markTeamMemberInboxRead } from "../../src/vendor/mpr-plugins/team/team-helpers";
import { isUserError } from "../../src/core/util/user-error";

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
  claude: "maw run claude",
  "claude-resume": "maw run claude-resume",
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
lifecycle:
  prompt_delay: 250
`);
    expect(charter.session).toBe("named-session");
    expect(charter.lifecycle?.prompt_delay).toBe(250);
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
    expect(status.output).toContain("bridge\tmawjs-oss-world\tclaude\tskipped\tskip (other node: oracle-world)");
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

  test("team up delays by lifecycle.prompt_delay after wake readiness before priming prompts", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-prompt-delay-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw"), { recursive: true });
    writeFileSync(join(root, ".maw", "m5.yaml"), `
name: m5-team
session: charter-session
lifecycle:
  prompt_delay: 42
agents:
  codex:
    engine: omx
    prompt: delayed hello
`, "utf-8");

    let listCalls = 0;
    const events: string[] = [];
    const tmux = {
      run: async (...args: string[]) => {
        events.push(`tmux:${args[0]}`);
        if (args[0] === "display-message") return "lead-session\n";
        if (args[0] === "list-panes") {
          listCalls++;
          if (listCalls === 1) return "";
          if (listCalls === 2) return "charter-session|codex|zsh|/wt/codex|%1";
          return "charter-session|codex|codex|/wt/codex|%1";
        }
        return "";
      },
    };

    await cmdTeamUp("any", { session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async () => { events.push("wake"); return "woke"; },
      cmdSendFn: async () => { events.push("send"); },
      sleep: async (ms: number) => { events.push(`sleep:${ms}`); },
      logger: () => {},
    });

    expect(events).toContain("sleep:42");
    expect(events.indexOf("sleep:1000")).toBeLessThan(events.indexOf("sleep:42"));
    expect(events.indexOf("sleep:42")).toBeLessThan(events.indexOf("send"));
  });

  test("team up launches missing members in parallel before readiness waits and prompt priming", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-parallel-wake-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw"), { recursive: true });
    writeFileSync(join(root, ".maw", "m5.yaml"), `
name: m5-team
session: charter-session
lifecycle:
  prompt_delay: 7
agents:
  coder-a:
    engine: omx
    prompt: prompt a
  coder-b:
    engine: claude48
    prompt: prompt b
`, "utf-8");

    let listCalls = 0;
    const events: string[] = [];
    const tmux = {
      run: async (...args: string[]) => {
        if (args[0] === "display-message") return "lead-session\n";
        if (args[0] === "list-panes") {
          listCalls++;
          if (listCalls === 1) return "";
          return [
            "charter-session|coder-a|codex|/wt/coder-a|%1",
            "charter-session|coder-b|claude|/wt/coder-b|%2",
          ].join("\n");
        }
        return "";
      },
    };
    const wakeResolvers: Array<() => void> = [];
    const wakes: any[] = [];

    const run = cmdTeamUp("any", { session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async (...args: any[]) => {
        wakes.push(args);
        events.push(`wake:start:${args[1].wt}`);
        await new Promise<void>((resolve) => wakeResolvers.push(resolve));
        events.push(`wake:end:${args[1].wt}`);
        return "woke";
      },
      cmdSendFn: async (...args: any[]) => { events.push(`prime:${args[0]}`); },
      sleep: async (ms: number) => { events.push(`sleep:${ms}`); },
      logger: () => {},
    });

    for (let i = 0; i < 20 && wakeResolvers.length < 2; i++) await Promise.resolve();

    expect(wakeResolvers).toHaveLength(2);
    expect(events).toEqual(["wake:start:coder-a", "wake:start:coder-b"]);
    expect(wakes.map((wake) => wake[1].wt)).toEqual(["coder-a", "coder-b"]);

    for (const resolveWake of wakeResolvers) resolveWake();
    await run;

    expect(events.indexOf("sleep:7")).toBeGreaterThan(events.indexOf("wake:end:coder-a"));
    expect(events.indexOf("sleep:7")).toBeGreaterThan(events.indexOf("wake:end:coder-b"));
    expect(events.indexOf("sleep:7")).toBeLessThan(events.indexOf("prime:charter-session:coder-a"));
    expect(events.indexOf("sleep:7")).toBeLessThan(events.indexOf("prime:charter-session:coder-b"));
  });

  test("--quick synthesizes an in-memory builder charter with explicit worktree names", async () => {
    expect(quickCharter(3, { name: "quick", engine: "omx", session: "charter-session" })).toMatchObject({
      name: "quick",
      session: "charter-session",
      members: [
        { role: "builder-1", name: "builder-1", engine: "omx", worktree: "builder-1" },
        { role: "builder-2", name: "builder-2", engine: "omx", worktree: "builder-2" },
        { role: "builder-3", name: "builder-3", engine: "omx", worktree: "builder-3" },
      ],
    });

    const root = tempRepo();
    let listCalls = 0;
    const tmux = {
      run: async (...args: string[]) => {
        if (args[0] === "display-message") return "lead-session\n";
        if (args[0] === "list-panes") {
          listCalls++;
          if (listCalls === 1) return "";
          return [
            "charter-session|builder-1|codex|/wt/builder-1|%1",
            "charter-session|builder-2|codex|/wt/builder-2|%2",
            "charter-session|builder-3|codex|/wt/builder-3|%3",
          ].join("\n");
        }
        return "";
      },
    };
    const wakes: any[] = [];

    const result = await cmdTeamUp("quick", { quick: 3, engine: "omx", session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      cmdWakeFn: async (...args: any[]) => { wakes.push(args); return "woke"; },
      sleep: async () => {},
      logger: () => {},
    });

    expect(wakes.map((wake) => wake[1])).toEqual([
      { wt: "builder-1", engine: "omx", session: "charter-session", repoPath: root },
      { wt: "builder-2", engine: "omx", session: "charter-session", repoPath: root },
      { wt: "builder-3", engine: "omx", session: "charter-session", repoPath: root },
    ]);
    expect(result.roster.map((member) => [member.role, member.engine, member.state])).toEqual([
      ["builder-1", "omx", "live"],
      ["builder-2", "omx", "live"],
      ["builder-3", "omx", "live"],
    ]);
  });

  test("team up wakes charter.project worktrees from the project repo while priming charter-local prompts (#2798)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-prompt-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "maw-target-project-"));
    dirs.push(root, projectRoot);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(projectRoot, ".git"));
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
      ghqFindFn: async (suffix: string) => suffix === "/soul-brews-studio/maw-js" ? projectRoot : null,
      sleep: async () => {},
      logger: () => {},
    });

    expect(wakes).toEqual([
      ["soul-brews-studio/maw-js", { wt: "codex", engine: "omx", session: "charter-session", repoPath: projectRoot, channels: true }],
      ["soul-brews-studio/maw-js", { wt: "claude48", engine: "claude48", session: "charter-session", repoPath: projectRoot, channels: true }],
    ]);
    expect(sends).toEqual([
      ["charter-session:codex", "inline prompt", false, { currentSession: "charter-session" }],
      ["charter-session:claude48", "file prompt", false, { currentSession: "charter-session" }],
    ]);
  });

  test("team up errors loudly when charter.project is not cloned for worktree creation (#2798)", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-node-missing-project-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw"), { recursive: true });
    writeFileSync(join(root, ".maw", "m5.yaml"), `
name: m5-team
project: soul-brews-studio/missing-project
agents:
  codex:
    engine: omx
`, "utf-8");
    const { tmux } = fakeTmux([]);
    const wakes: any[] = [];

    await expect(cmdTeamUp("any", { session: "charter-session" }, {
      cwd: root,
      tmux,
      loadConfigFn: () => ({ ...config, node: "m5" }),
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      ghqFindFn: async () => null,
      sleep: async () => {},
      logger: () => {},
    })).rejects.toThrow("charter.project 'soul-brews-studio/missing-project' is not cloned under ghq");
    expect(wakes).toEqual([]);
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


  test("team up preflight aborts before spawn when charter engine is unresolved", async () => {
    const root = tempRepo();
    const { tmux, calls } = fakeTmux([]);
    const wakes: any[] = [];
    const badConfig = { commands: { default: "claude", codex: "codex" } } as any;
    let thrown: unknown;

    try {
      await cmdTeamUp("alpha", {}, {
        cwd: root,
        tmux,
        loadConfigFn: () => badConfig,
        cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
        sleep: async () => {},
        logger: () => {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("team up preflight failed");
    expect((thrown as Error).message).toContain("coder-1: engine 'omx' not resolvable");
    expect(wakes).toHaveLength(0);
    expect(calls.some((call) => call[0] === "send-keys" || call[0] === "kill-window")).toBe(false);
  });

  test("role matching is anchored so coder-1 does not match coder-10", () => {
    const panes = [{ sessionName: "s", windowName: "repo-coder-10", command: "claude", path: "/x", paneId: "%1" }];
    expect(classifyMember({ role: "coder-1" }, panes, "s").state).toBe("missing");
    expect(classifyMember({ role: "coder-10" }, panes, "s").state).toBe("live");
  });



  test("team up preflight rejects codex-like members pinned to shared checkout with worktree:false (#2764)", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "shared-codex.yaml"), `
name: shared-codex
session: charter-session
members:
  - role: codex-main
    engine: codex
    worktree: false
`, "utf-8");
    const { tmux } = fakeTmux([]);

    await expect(cmdTeamUp("shared-codex", { dryRun: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      logger: () => {},
    })).rejects.toThrow("codex-like members must run in isolated worktrees");
  });

  test("classifyMember matches wake-produced dot worktree windows (#2802)", () => {
    const panes = [{ sessionName: "s", windowName: "web-v2-web-v2.wt-coder-2", command: "codex", path: "/wt/web-v2.wt-coder-2", paneId: "%2" }];
    expect(classifyMember({ role: "coder-2", worktree: "web-v2.wt-coder-2" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("live");
  });

  test("classifyMember keeps explicit member name matching live (#2802)", () => {
    const panes = [{ sessionName: "s", windowName: "web-v2-web-v2.wt-coder-2", command: "codex", path: "/wt/web-v2.wt-coder-2", paneId: "%2" }];
    expect(classifyMember({ role: "coder-2", name: "web-v2.wt-coder-2" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("live");
  });

  test("classifyMember keeps role-only wake window matching live (#2802)", () => {
    const panes = [{ sessionName: "s", windowName: "web-v2-coder-2", command: "codex", path: "/wt/coder-2", paneId: "%2" }];
    expect(classifyMember({ role: "coder-2" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("live");
  });

  test("classifyMember does not match absent members through wake candidates (#2802)", () => {
    const panes = [{ sessionName: "s", windowName: "web-v2-coder-2", command: "codex", path: "/wt/coder-2", paneId: "%2" }];
    expect(classifyMember({ role: "coder-3" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("missing");
  });

  test("classifyMember wake candidates remain anchored for numbered roles (#2802)", () => {
    const panes = [{ sessionName: "s", windowName: "web-v2-coder-10", command: "codex", path: "/wt/coder-10", paneId: "%10" }];
    expect(classifyMember({ role: "coder-1" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("missing");
    expect(classifyMember({ role: "coder-10" }, panes, "s", { repoSlug: "web-v2" }).state).toBe("live");
  });

  test("commands team-liveness re-exports the vendor source of truth (#2802)", () => {
    expect(commandTeamLiveness.classifyMember).toBe(vendorTeamLiveness.classifyMember);
    expect(commandTeamLiveness.memberWindowCandidates).toBe(vendorTeamLiveness.memberWindowCandidates);
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
    expect(calls).toContainEqual(["send-keys", "-t", "%10", "C-u"]);
    expect(calls).toContainEqual(["send-keys", "-t", "%10", "maw run claude48-resume", "Enter"]);
    expect(calls.findIndex((entry) => entry[0] === "send-keys" && entry[1] === "-t" && entry[2] === "%10" && entry[3] === "C-u"))
      .toBeLessThan(
        calls.findIndex((entry) => entry[0] === "send-keys" && entry[1] === "-t" && entry[2] === "%10" && entry[3] === "maw run claude48-resume"),
      );
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


  test("--members filters by charter role, warns unknown roles, and wakes only selected members", async () => {
    const root = tempRepo();
    const { tmux } = fakeTmux([]);
    const wakes: any[] = [];

    const status = await cmdTeamUp("alpha", { status: true, members: ["coder-1", "mawjs-oracle", "missing-role"] }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      logger: () => {},
    });
    expect(status.roster.map((m) => [m.role, m.state, m.skipReason])).toEqual([
      ["coder-1", "missing", undefined],
      ["coder-10", "skipped", "outside --members"],
      ["oracle", "skipped", "outside --members"],
    ]);
    expect(status.warnings).toContain("--members role not found in charter: mawjs-oracle");
    expect(status.warnings).toContain("--members role not found in charter: missing-role");

    await cmdTeamUp("alpha", { members: ["coder-1"] }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      sleep: async () => {},
      logger: () => {},
    });
    expect(wakes.map((w) => w[1].wt)).toEqual(["coder-1"]);
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
    expect(status.output).toContain("lead\tmawjs-oracle\tclaude\tmissing\twakeable mawjs-oracle -e claude --session charter-session");
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


  test("dry-run action commands resolve charter engines with YAML anchor flags", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "anchors.yaml"), `
name: anchors
session: charter-session
flags:
  claude-combo: &claude-combo
    - "--dangerously-skip-permissions"
    - "--channels plugin:discord@claude-plugins-official"
engines:
  opus48: ["claude --model claude-opus-4-8", *claude-combo]
members:
  - role: builder
    engine: opus48
`, "utf-8");
    const { tmux } = fakeTmux([]);

    const result = await cmdTeamUp("anchors", { dryRun: true }, { cwd: root, tmux, loadConfigFn: () => config, logger: () => {} });

    expect(result.actions[0]).toMatchObject({
      role: "builder",
      command: "claude --model claude-opus-4-8 --dangerously-skip-permissions --channels plugin:discord@claude-plugins-official",
    });
  });

  test("engine command resolves resume key only when requested", () => {
    expect(engineCommand("omx", {}, config)).toBe("maw run omx");
    expect(engineCommand("omx", { resume: true }, config)).toBe("maw run omx-resume");
    expect(engineCommand("opus48", { engines: { opus48: ["claude --model opus", ["--dangerously-skip-permissions", "--channels plugin:discord"]] } }, config)).toBe("claude --model opus --dangerously-skip-permissions --channels plugin:discord");
    expect(engineCommand("opus48", { resume: true, engines: { "opus48-resume": ["claude --resume abc", ["--dangerously-skip-permissions"]] } }, config)).toBe("claude --resume abc --dangerously-skip-permissions");
  });
});

describe("team inbox handoff on team up (#2742)", () => {
  // _setDirs mutates the module-global TEAMS_DIR; capture + restore so the
  // handoff store points at a temp dir per test and never leaks into the rest
  // of the suite (or a real ~/.claude/teams on the dev machine).
  const ORIG_TEAMS = TEAMS_DIR;
  const ORIG_TASKS = TASKS_DIR;
  afterEach(() => { _setDirs(ORIG_TEAMS, ORIG_TASKS); });

  function seedTeamInbox(team: string, role: string, messages: unknown[]): void {
    const teamsRoot = mkdtempSync(join(tmpdir(), "maw-team-store-"));
    dirs.push(teamsRoot);
    const inboxDir = join(teamsRoot, team, "inboxes");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, `${role}.json`), JSON.stringify(messages, null, 2));
    _setDirs(teamsRoot, join(teamsRoot, "tasks"));
  }

  function charterRepo(team: string): string {
    const root = mkdtempSync(join(tmpdir(), "maw-inbox-up-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw", "teams"), { recursive: true });
    writeFileSync(join(root, ".maw", "teams", `${team}.yaml`), `
name: ${team}
session: charter-session
members:
  - role: coder
    engine: omx
    worktree: true
`, "utf-8");
    return root;
  }

  function liveOnSecondPoll(pane: string) {
    let listCalls = 0;
    return {
      run: async (...args: string[]) => {
        if (args[0] === "display-message") return "lead-session\n";
        if (args[0] === "list-panes") {
          listCalls++;
          return listCalls === 1 ? "" : pane;
        }
        return "";
      },
    };
  }

  test("readUnreadTeamMemberInbox returns only unread; markTeamMemberInboxRead flips them", () => {
    seedTeamInbox("t", "m", [
      { from: "a", summary: "one", read: false },
      { from: "b", summary: "two", read: true },
      { from: "c", summary: "three", read: false },
    ]);

    expect(readUnreadTeamMemberInbox("t", "m").map((msg) => msg.summary)).toEqual(["one", "three"]);
    expect(markTeamMemberInboxRead("t", "m")).toBe(2);
    expect(readUnreadTeamMemberInbox("t", "m")).toHaveLength(0);
    expect(markTeamMemberInboxRead("t", "m")).toBe(0);
    expect(readUnreadTeamMemberInbox("t", "absent-member")).toEqual([]);
  });

  test("formatTeamInboxHandoff summarizes unread messages with sender labels", () => {
    const msg = formatTeamInboxHandoff("coder", [
      { from: "lead", summary: "do the thing" },
      { from: "reviewer", summary: "rebase first" },
    ]);
    expect(msg).toContain("2 unread");
    expect(msg).toContain("coder");
    expect(msg).toContain("[lead] do the thing");
    expect(msg).toContain("[reviewer] rebase first");
  });

  test("team up delivers unread team inbox messages to a freshly woken member and marks them read", async () => {
    const root = charterRepo("inboxteam");
    seedTeamInbox("inboxteam", "coder", [
      { from: "lead", text: "{}", summary: "finish the parser refactor", timestamp: "2026-06-15T10:00:00.000Z", read: false },
      { from: "lead", text: "{}", summary: "already-seen note", timestamp: "2026-06-14T10:00:00.000Z", read: true },
      { from: "reviewer", text: "{}", summary: "rebase onto alpha before pushing", timestamp: "2026-06-15T11:00:00.000Z", read: false },
    ]);
    const sends: any[] = [];

    await cmdTeamUp("inboxteam", { session: "charter-session" }, {
      cwd: root,
      tmux: liveOnSecondPoll("charter-session|coder|omx|/wt/coder|%1"),
      loadConfigFn: () => config,
      cmdWakeFn: async () => "woke",
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      sleep: async () => {},
      logger: () => {},
    });

    expect(sends).toHaveLength(1);
    const [target, message] = sends[0];
    expect(target).toBe("charter-session:coder");
    expect(message).toContain("2 unread");
    expect(message).toContain("finish the parser refactor");
    expect(message).toContain("rebase onto alpha before pushing");
    expect(message).not.toContain("already-seen note");

    expect(readUnreadTeamMemberInbox("inboxteam", "coder")).toHaveLength(0);
  });

  test("priming prompt and inbox handoff are merged into a single send, not two injections", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-inbox-prime-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw", "teams"), { recursive: true });
    writeFileSync(join(root, ".maw", "teams", "primeteam.yaml"), `
name: primeteam
session: charter-session
members:
  - role: coder
    engine: omx
    worktree: true
    prompt: kick off the build
`, "utf-8");
    seedTeamInbox("primeteam", "coder", [
      { from: "lead", summary: "merge this note", read: false },
    ]);
    const sends: any[] = [];

    await cmdTeamUp("primeteam", { session: "charter-session" }, {
      cwd: root,
      tmux: liveOnSecondPoll("charter-session|coder|omx|/wt/coder|%1"),
      loadConfigFn: () => config,
      cmdWakeFn: async () => "woke",
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      sleep: async () => {},
      logger: () => {},
    });

    expect(sends).toHaveLength(1);
    const [, message] = sends[0];
    expect(message).toContain("kick off the build");
    expect(message).toContain("merge this note");
    expect(message.indexOf("kick off the build")).toBeLessThan(message.indexOf("merge this note"));
    expect(readUnreadTeamMemberInbox("primeteam", "coder")).toHaveLength(0);
  });

  test("inbox handoff is keyed by the charter name, not the team-up argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-inbox-alias-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".maw", "teams"), { recursive: true });
    // Charter file is found by the CLI arg (aliasteam.yaml) but its internal
    // name — where charter prep + `maw team send` actually write inboxes — is realteam.
    writeFileSync(join(root, ".maw", "teams", "aliasteam.yaml"), `
name: realteam
session: charter-session
members:
  - role: coder
    engine: omx
    worktree: true
`, "utf-8");
    seedTeamInbox("realteam", "coder", [
      { from: "lead", summary: "keyed by charter name", read: false },
    ]);
    const sends: any[] = [];

    await cmdTeamUp("aliasteam", { session: "charter-session" }, {
      cwd: root,
      tmux: liveOnSecondPoll("charter-session|coder|omx|/wt/coder|%1"),
      loadConfigFn: () => config,
      cmdWakeFn: async () => "woke",
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      sleep: async () => {},
      logger: () => {},
    });

    expect(sends).toHaveLength(1);
    expect(sends[0][1]).toContain("keyed by charter name");
    expect(readUnreadTeamMemberInbox("realteam", "coder")).toHaveLength(0);
  });

  test("team up does not deliver a handoff when the member inbox has no unread messages", async () => {
    const root = charterRepo("emptyteam");
    seedTeamInbox("emptyteam", "coder", [
      { from: "lead", summary: "old news", read: true },
    ]);
    const sends: any[] = [];

    await cmdTeamUp("emptyteam", { session: "charter-session" }, {
      cwd: root,
      tmux: liveOnSecondPoll("charter-session|coder|omx|/wt/coder|%1"),
      loadConfigFn: () => config,
      cmdWakeFn: async () => "woke",
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      sleep: async () => {},
      logger: () => {},
    });

    expect(sends).toHaveLength(0);
  });

  test("team up --status does not deliver inbox handoff or mark messages read", async () => {
    const root = charterRepo("inboxteam");
    seedTeamInbox("inboxteam", "coder", [
      { from: "lead", summary: "finish the parser refactor", read: false },
      { from: "reviewer", summary: "rebase onto alpha before pushing", read: false },
    ]);
    const sends: any[] = [];

    await cmdTeamUp("inboxteam", { status: true, session: "charter-session" }, {
      cwd: root,
      tmux: fakeTmux([]).tmux,
      loadConfigFn: () => config,
      cmdSendFn: async (...a: any[]) => { sends.push(a); },
      logger: () => {},
    });

    expect(sends).toHaveLength(0);
    expect(readUnreadTeamMemberInbox("inboxteam", "coder")).toHaveLength(2);
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

describe("maw team apply (#2612)", () => {
  test("dry-run compares charter to live tmux state without spawning or shutting down", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "apply.yaml"), `
name: apply
session: charter-session
members:
  - role: lead
    name: mawjs-oracle
    engine: claude
    worktree: false
  - role: reviewer
    name: reviewer
    engine: codex
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-oracle|claude|/repo|%1",
      "charter-session|mawjs-old-worker|codex|/wt/old-worker|%2",
    ]);
    const wakes: any[] = [];
    const doneCalls: any[] = [];

    const result = await cmdTeamApply("apply", {}, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      repoSlug: "Soul-Brews-Studio/maw-js",
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });

    expect(result.actions.map((a) => [a.kind, a.role, a.action, a.target])).toEqual([
      ["skip", "lead", "skip live", undefined],
      ["spawn", "reviewer", "would spawn member", undefined],
      ["shutdown", "mawjs-old-worker", "would maw done removed member", "mawjs-old-worker"],
    ]);
    expect(wakes).toEqual([]);
    expect(doneCalls).toEqual([]);
    expect(result.output).toContain("No changes made (pass --apply to execute)");
  });

  test("--apply spawns missing members and gracefully shuts down removed panes", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "apply.yaml"), `
name: apply
session: charter-session
members:
  - role: reviewer
    name: reviewer
    engine: codex
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-old-worker|codex|/wt/old-worker|%2",
    ]);
    const wakes: any[] = [];
    const doneCalls: any[] = [];

    const result = await cmdTeamApply("apply", { apply: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      repoRoot: root,
      repoSlug: "Soul-Brews-Studio/maw-js",
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      logger: () => {},
    });

    expect(result.actions.map((a) => [a.kind, a.role, a.action])).toEqual([
      ["spawn", "reviewer", "spawn member"],
      ["shutdown", "mawjs-old-worker", "maw done removed member"],
    ]);
    expect(wakes).toEqual([["Soul-Brews-Studio/maw-js", {
      engine: "codex",
      session: "charter-session",
      repoPath: root,
      wt: "reviewer",
    }]]);
    expect(doneCalls).toEqual([["mawjs-old-worker", { sessionName: "charter-session" }]]);
  });

  test("reports live member engine and branch drift without auto-migrating", async () => {
    const root = tempRepo();
    writeFileSync(join(root, ".maw", "teams", "apply.yaml"), `
name: apply
session: charter-session
members:
  - role: reviewer
    name: reviewer
    engine: codex
    branch: next
    worktree: true
`, "utf-8");
    const { tmux } = fakeTmux([
      "charter-session|mawjs-reviewer|claude|/wt/reviewer|%2",
    ]);
    const wakes: any[] = [];
    const doneCalls: any[] = [];

    const result = await cmdTeamApply("apply", { apply: true }, {
      cwd: root,
      tmux,
      loadConfigFn: () => config,
      repoSlug: "Soul-Brews-Studio/maw-js",
      cmdWakeFn: async (...a: any[]) => { wakes.push(a); return "woke"; },
      cmdDoneFn: async (...a: any[]) => { doneCalls.push(a); },
      branchForPathFn: () => "main",
      logger: () => {},
    });

    expect(result.actions.map((a) => [a.kind, a.role, a.action, a.detail])).toEqual([
      ["report", "reviewer", "engine changed; not migrated", "live=claude charter=codex"],
      ["report", "reviewer", "branch changed; not migrated", "live=main charter=next"],
    ]);
    expect(wakes).toEqual([]);
    expect(doneCalls).toEqual([]);
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
    expect(res.output).toContain("--members <roles>");
  });

  test("`team down` is a known subcommand", async () => {
    const { res } = await dispatch(["down"]);
    expect(res.error).not.toContain("unknown subcommand");
    expect(res.error).toBe("team required");
  });
});
