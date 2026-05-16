import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "path";
import {
  autoSave,
  cmdDone,
  removeFromFleetConfig,
  removeWorktreeByGhqScan,
  removeWorktreeViaConfig,
  signalParentInbox,
  type DoneDeps,
} from "../src/commands/shared/done";

type WindowInfo = { index: number; name: string; active: boolean };
type SessionInfo = { name: string; windows: WindowInfo[] };

function createMemoryFs(initial: Record<string, string> = {}, options: { failReaddir?: boolean; failAppend?: boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];

  return {
    files,
    dirs,
    fs: {
      mkdirSync(path: string) {
        dirs.push(path);
      },
      appendFileSync(path: string, data: string) {
        if (options.failAppend) throw new Error("append failed");
        files.set(path, (files.get(path) ?? "") + data);
      },
      readdirSync(path: string) {
        if (options.failReaddir) throw new Error("readdir failed");
        const entries = [...files.keys()]
          .filter((file) => dirname(file) === path)
          .map((file) => basename(file));
        return [...new Set(entries)];
      },
      readFileSync(path: string) {
        const data = files.get(path);
        if (data === undefined) throw new Error(`missing ${path}`);
        return data;
      },
      writeFileSync(path: string, data: string) {
        files.set(path, data);
      },
    } satisfies NonNullable<DoneDeps["fs"]>,
  };
}

function createHarness(options: {
  sessions?: SessionInfo[];
  files?: Record<string, string>;
  hostExec?: (command: string) => Promise<string> | string;
  tmuxKillFails?: boolean;
  tmuxSendFails?: boolean;
  fsFailReaddir?: boolean;
  fsFailAppend?: boolean;
} = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const commands: string[] = [];
  const killed: string[] = [];
  const sent: Array<{ target: string; text: string }> = [];
  const sleeps: number[] = [];
  const snapshots: string[] = [];
  const memory = createMemoryFs(options.files, {
    failReaddir: options.fsFailReaddir,
    failAppend: options.fsFailAppend,
  });
  const sessions = options.sessions ?? [
    {
      name: "work",
      windows: [
        { index: 0, name: "lead/main", active: true },
        { index: 1, name: "tile-1", active: false },
      ],
    },
  ];

  const deps: DoneDeps = {
    listSessions: async () => sessions,
    ghqRoot: "/repos",
    fleetDir: "/fleet",
    homeDir: "/home/tester",
    now: () => new Date("2026-05-17T01:02:03.004Z"),
    fs: memory.fs,
    logger: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    },
    hostExec: async (command: string) => {
      commands.push(command);
      if (options.hostExec) return await options.hostExec(command);
      if (command.includes("pane_current_path")) return "/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1\n";
      if (command.startsWith("find ")) return "";
      return "";
    },
    tmux: {
      killWindow: async (target: string) => {
        killed.push(target);
        if (options.tmuxKillFails) throw new Error("kill failed");
      },
      sendText: async (target: string, text: string) => {
        sent.push({ target, text });
        if (options.tmuxSendFails) throw new Error("send failed");
      },
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    takeSnapshot: async (trigger: string) => {
      snapshots.push(trigger);
      return "/snapshot.json";
    },
  };

  return { deps, logs, errors, commands, killed, sent, sleeps, snapshots, files: memory.files, dirs: memory.dirs };
}

let oldAgentName: string | undefined;

beforeEach(() => {
  oldAgentName = process.env.CLAUDE_AGENT_NAME;
  process.env.CLAUDE_AGENT_NAME = "codex-agent";
});

afterEach(() => {
  if (oldAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = oldAgentName;
});

describe("cmdDone", () => {
  test("dry-run on a running window signals parent and stops before destructive cleanup", async () => {
    const h = createHarness();

    await cmdDone(" tile-1/ ", { dryRun: true }, h.deps);

    expect(h.commands).toEqual(["tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'"]);
    expect(h.killed).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(h.logs.join("\n")).toContain("would send /rrr to work:tile-1");
    expect(h.logs.join("\n")).toContain("would git add + commit + push");

    const inboxPath = "/home/tester/.oracle/inbox/leadmain.jsonl";
    expect(h.dirs).toContain("/home/tester/.oracle/inbox");
    const signal = JSON.parse(h.files.get(inboxPath)!.trim());
    expect(signal).toEqual({
      ts: "2026-05-17T01:02:03.004Z",
      from: "codex-agent",
      type: "done",
      msg: "worktree tile-1 completed",
      thread: null,
    });
  });

  test("--force skips autosave, kills the window, removes configured worktree, updates fleet, and snapshots", async () => {
    const fleetFile = "/fleet/team.json";
    const h = createHarness({
      files: {
        [fleetFile]: JSON.stringify({
          windows: [
            { name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-tile-1" },
            { name: "lead", repo: "Soul-Brews-Studio/maw-js" },
          ],
        }),
      },
      hostExec: (command) => {
        if (command.includes("rev-parse")) return "feature/done\n";
        return "";
      },
    });

    await cmdDone("TILE-1", { force: true }, h.deps);

    expect(h.commands).not.toContain("tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'");
    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' --force",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree prune",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' branch -d 'feature/done'",
    ]);
    expect(JSON.parse(h.files.get(fleetFile)!)).toEqual({
      windows: [{ name: "lead", repo: "Soul-Brews-Studio/maw-js" }],
    });
    expect(h.snapshots).toEqual(["done"]);
  });

  test("kill failure and missing cleanup targets are reported without throwing", async () => {
    const h = createHarness({ tmuxKillFails: true });

    await cmdDone("tile-1", { force: true }, h.deps);

    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.logs.join("\n")).toContain("could not kill window");
    expect(h.logs.join("\n")).toContain("no worktree to remove");
    expect(h.logs.join("\n")).toContain("not in any fleet config");
    expect(h.snapshots).toEqual(["done"]);
  });

  test("snapshot failures are swallowed after cleanup completes", async () => {
    const h = createHarness();
    const deps: DoneDeps = {
      ...h.deps,
      takeSnapshot: async () => {
        throw new Error("snapshot offline");
      },
    };

    await cmdDone("tile-1", { force: true }, deps);
    await Promise.resolve();

    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.logs.join("\n")).toContain("killed window work:tile-1");
  });

  test("dry-run for a missing window reports that no autosave target is running", async () => {
    const h = createHarness({
      sessions: [{ name: "work", windows: [{ index: 0, name: "lead", active: true }] }],
    });

    await cmdDone("missing", { dryRun: true }, h.deps);

    expect(h.logs.join("\n")).toContain("window 'missing' not running — nothing to auto-save");
    expect(h.logs.join("\n")).toContain("window 'missing' not running");
    expect(h.killed).toEqual([]);
    expect(h.snapshots).toEqual(["done"]);
  });
});

describe("done inbox and autosave helpers", () => {
  test("signalParentInbox no-ops without a parent and logs fs errors", () => {
    const noParent = createHarness();
    signalParentInbox("tile-1", "missing", [], noParent.deps);
    expect(noParent.files.size).toBe(0);

    const failing = createHarness({ fsFailAppend: true });
    signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ], failing.deps);
    expect(failing.errors.join("\n")).toContain("inbox signal failed");
  });

  test("signalParentInbox can use the default clock when tests inject only filesystem paths", () => {
    const memory = createMemoryFs();
    signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ], {
      fs: memory.fs,
      homeDir: "/home/default-clock",
      logger: { log() {}, error() {} },
    });

    const signal = JSON.parse(memory.files.get("/home/default-clock/.oracle/inbox/lead.jsonl")!.trim());
    expect(Number.isNaN(Date.parse(signal.ts))).toBe(false);
    expect(signal.msg).toBe("worktree tile-1 completed");
  });

  test("autoSave sends /rrr, waits, and commits/pushes when pane cwd is known", async () => {
    const h = createHarness();

    await autoSave("tile-1", "work", {}, h.deps);

    expect(h.sent).toEqual([{ target: "work:tile-1", text: "/rrr" }]);
    expect(h.sleeps).toEqual([10_000]);
    expect(h.commands).toEqual([
      "tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' add -A",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' commit -m 'chore: auto-save before done'",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' push",
    ]);
    expect(h.logs.join("\n")).toContain("committed changes");
    expect(h.logs.join("\n")).toContain("pushed to remote");
  });

  test("autoSave reports tmux send, commit, push, and git add failures", async () => {
    const sendFail = createHarness({ tmuxSendFails: true });
    await autoSave("tile-1", "work", {}, sendFail.deps);
    expect(sendFail.logs.join("\n")).toContain("could not send /rrr");

    const commitPushFail = createHarness({
      hostExec: (command) => {
        if (command.includes("pane_current_path")) return "/repo";
        if (command.includes(" commit ")) throw new Error("nothing");
        if (command.endsWith(" push")) throw new Error("denied");
        return "";
      },
    });
    await autoSave("tile-1", "work", {}, commitPushFail.deps);
    expect(commitPushFail.logs.join("\n")).toContain("nothing to commit");
    expect(commitPushFail.logs.join("\n")).toContain("push failed");

    const addFail = createHarness({
      hostExec: (command) => {
        if (command.includes("pane_current_path")) return "/repo";
        if (command.endsWith(" add -A")) throw new Error("add failed");
        return "";
      },
    });
    await autoSave("tile-1", "work", {}, addFail.deps);
    expect(addFail.logs.join("\n")).toContain("git auto-save failed: add failed");
  });

  test("autoSave dry-run still explains the flow when pane cwd lookup fails", async () => {
    const h = createHarness({
      hostExec: () => {
        throw new Error("pane missing");
      },
    });

    await autoSave("tile-1", "work", { dryRun: true }, h.deps);

    expect(h.logs.join("\n")).toContain("would send /rrr to work:tile-1");
    expect(h.logs.join("\n")).not.toContain("would git add + commit + push");
  });
});

describe("done worktree cleanup helpers", () => {
  test("removeWorktreeViaConfig removes configured worktrees and skips main/HEAD branch deletion", async () => {
    const h = createHarness({
      files: {
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-tile-1" }],
        }),
      },
      hostExec: (command) => {
        if (command.includes("rev-parse")) return "main\n";
        return "";
      },
    });

    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", h.deps)).resolves.toBe(true);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' --force",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree prune",
    ]);
  });

  test("removeWorktreeViaConfig returns false for non-worktrees, remove failures, and fleet scan errors", async () => {
    const nonWorktree = createHarness({
      files: {
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "lead", repo: "Soul-Brews-Studio/maw-js" }],
        }),
      },
    });
    await expect(removeWorktreeViaConfig("lead", "/repos/github.com", nonWorktree.deps)).resolves.toBe(false);

    const removeFail = createHarness({
      files: {
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-tile-1" }],
        }),
      },
      hostExec: (command) => {
        if (command.includes("worktree remove")) throw new Error("busy");
        return "feature\n";
      },
    });
    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", removeFail.deps)).resolves.toBe(false);
    expect(removeFail.logs.join("\n")).toContain("worktree remove failed: busy");

    const scanFail = createHarness({ fsFailReaddir: true });
    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", scanFail.deps)).resolves.toBe(false);
    expect(scanFail.errors.join("\n")).toContain("fleet scan failed");
  });

  test("removeWorktreeByGhqScan removes matching suffix worktrees and ignores branch-delete failures", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) {
          return [
            "/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1",
            "/repos/github.com/Soul-Brews-Studio/maw-js.wt-other",
          ].join("\n");
        }
        if (command.includes("rev-parse")) return "feature/scan\n";
        if (command.includes("branch -d")) throw new Error("not merged");
        return "";
      },
    });

    await expect(removeWorktreeByGhqScan("6-tile-1", "/repos/github.com", h.deps)).resolves.toBe(true);

    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1' rev-parse --abbrev-ref HEAD");
    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1' --force");
    expect(h.logs.join("\n")).toContain("removed worktree maw-js.wt-6-tile-1");
    expect(h.logs.join("\n")).not.toContain("deleted branch feature/scan");
  });

  test("removeWorktreeByGhqScan reports find and per-worktree failures", async () => {
    const findFail = createHarness({
      hostExec: () => {
        throw new Error("find failed");
      },
    });
    await expect(removeWorktreeByGhqScan("tile-1", "/repos/github.com", findFail.deps)).resolves.toBe(false);
    expect(findFail.errors.join("\n")).toContain("worktree scan failed: Error: find failed");

    const removeFail = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) return "/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1\n";
        if (command.includes("worktree remove")) throw new Error("busy");
        return "";
      },
    });
    await expect(removeWorktreeByGhqScan("x-tile-1", "/repos/github.com", removeFail.deps)).resolves.toBe(false);
    expect(removeFail.errors.join("\n")).toContain("worktree remove failed: Error: busy");
  });

  test("removeFromFleetConfig rewrites matching configs and ignores missing fleet dirs", () => {
    const h = createHarness({
      files: {
        "/fleet/team.json": JSON.stringify({
          windows: [
            { name: "tile-1", repo: "repo.wt-tile-1" },
            { name: "lead", repo: "repo" },
          ],
        }),
        "/fleet/readme.txt": "ignored",
      },
    });

    expect(removeFromFleetConfig("tile-1", h.deps)).toBe(true);
    expect(JSON.parse(h.files.get("/fleet/team.json")!)).toEqual({
      windows: [{ name: "lead", repo: "repo" }],
    });
    expect(h.logs.join("\n")).toContain("removed from team.json");

    const missing = createHarness({ fsFailReaddir: true });
    expect(removeFromFleetConfig("tile-1", missing.deps)).toBe(false);
  });
});
