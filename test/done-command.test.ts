import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "path";
import {
  autoSave,
  cmdDone,
  cleanupDoneBranch,
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
  /** Engine to tag every window with in the injected fleet records (D3 retro). */
  engine?: string;
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
    // D3: the retro form comes from the window's authoritative fleet engine,
    // not the pane command. Tag every window with `options.engine` (claude).
    loadFleetEntries: () => sessions.map((s, i) => ({
      file: `${i}-${s.name}.json`,
      num: i,
      groupName: s.name,
      session: {
        name: s.name,
        windows: s.windows.map((w) => ({
          name: w.name,
          repo: "org/repo",
          runtime: { engine: options.engine ?? "claude", cwd: "/repos", nativeSessionId: "sess", capturedAt: "2026-05-17T00:00:00.000Z" },
        })),
      },
    })) as any,
    readWorktreeEngineFile: () => undefined,
    reunion: async () => undefined,
    soulSync: async () => undefined,
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
let oldMawDataDir: string | undefined;

beforeEach(() => {
  oldAgentName = process.env.CLAUDE_AGENT_NAME;
  oldMawDataDir = process.env.MAW_DATA_DIR;
  process.env.CLAUDE_AGENT_NAME = "codex-agent";
  process.env.MAW_DATA_DIR = "/xdg-data";
});

afterEach(() => {
  if (oldAgentName === undefined) delete process.env.CLAUDE_AGENT_NAME;
  else process.env.CLAUDE_AGENT_NAME = oldAgentName;
  if (oldMawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = oldMawDataDir;
});

describe("cmdDone", () => {
  test("dry-run on a running window previews without side effects or destructive cleanup", async () => {
    const h = createHarness();

    await cmdDone(" tile-1/ ", { dryRun: true }, h.deps);

    // Honest dry-run (alpha c4195acf): the preview continues through the READ-ONLY
    // worktree resolution (fleet config + ghq scan) so it reflects what a real done
    // would find, instead of returning early with an optimistic claim.
    expect(h.commands).toEqual([
      "tmux display-message -t 'work:tile-1' -p '#{pane_current_path}'",
      "find '/repos/github.com' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null",
    ]);
    expect(h.killed).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(h.logs.join("\n")).toContain("would send /rrr to work:tile-1");
    expect(h.logs.join("\n")).toContain("would git add + commit + push");

    // A dry-run must not mutate anything. The parent inbox signal ("worktree
    // completed") is a real side effect, so it is deferred to a real done.
    expect(h.files.get("/xdg-data/inbox/leadmain.jsonl")).toBeUndefined();
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

    expect(h.commands).not.toContain("tmux display-message -t 'work:tile-1' -p '#{pane_current_command}\t#{pane_current_path}'");
    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' rev-parse --abbrev-ref HEAD",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1' --force",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree prune",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/done' 'alpha'",
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

  test("a reunion failure is best-effort and never aborts teardown", async () => {
    const h = createHarness();
    // Not --force, so autoSave runs; reunion (an auxiliary post-save step) throws.
    const deps: DoneDeps = { ...h.deps, reunion: async () => { throw new Error("reunion offline"); } };

    await cmdDone("tile-1", {}, deps);

    // Teardown still completed: the reunion error was swallowed and logged.
    expect(h.logs.join("\n")).toContain("reunion skipped");
    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.snapshots).toEqual(["done"]);
  });

  test("a preservation (fleet-load) failure aborts before the completion signal or any teardown", async () => {
    const h = createHarness();
    // autoSave resolves the retro engine via loadFleetEntries — make it throw to
    // model a fleet/config read failure during the pre-kill preservation step.
    const deps: DoneDeps = { ...h.deps, loadFleetEntries: () => { throw new Error("fleet unreadable"); } };

    await expect(cmdDone("tile-1", {}, deps)).rejects.toThrow("fleet unreadable");

    // No "completed" signal was emitted, and nothing was torn down (fail-closed):
    // the signal is bound to successful preservation, which threw.
    expect([...h.files.keys()].some((k) => k.includes("/inbox/"))).toBe(false);
    expect(h.killed).toEqual([]);
    expect(h.snapshots).toEqual([]);
  });

  test("the successful path signals the parent exactly once, then tears down", async () => {
    const h = createHarness();

    await cmdDone("tile-1", {}, h.deps);

    const inboxFiles = [...h.files.entries()].filter(([k]) => k.includes("/inbox/"));
    expect(inboxFiles).toHaveLength(1);
    expect(inboxFiles[0]![1].trim().split("\n")).toHaveLength(1); // exactly one signal line
    expect(h.killed).toEqual(["work:tile-1"]);
    expect(h.snapshots).toEqual(["done"]);
  });

  test("dry-run for a missing window reports lookup paths without mutating cleanup state", async () => {
    const fleetFile = "/fleet/team.json";
    const h = createHarness({
      sessions: [{ name: "work", windows: [{ index: 0, name: "lead", active: true }] }],
      files: {
        [fleetFile]: JSON.stringify({ windows: [{ name: "missing", repo: "org/repo.wt-missing" }] }),
      },
      hostExec: (command) => {
        if (command.startsWith("find ")) return "";
        throw new Error(`dry-run should not mutate: ${command}`);
      },
    });

    await cmdDone("missing", { dryRun: true }, h.deps);

    expect(h.logs.join("\n")).toContain("window 'missing' not running — nothing to auto-save");
    expect(h.logs.join("\n")).toContain("[dry-run] would remove worktree org/repo.wt-missing");
    expect(h.logs.join("\n")).toContain("[dry-run] would remove 'missing' from fleet config if present");
    expect(h.killed).toEqual([]);
    expect(h.snapshots).toEqual([]);
    expect(JSON.parse(h.files.get(fleetFile)!)).toEqual({ windows: [{ name: "missing", repo: "org/repo.wt-missing" }] });
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

  test("signalParentInbox uses XDG data inbox even when tests inject only filesystem paths", () => {
    const memory = createMemoryFs();
    signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ], {
      fs: memory.fs,
      homeDir: "/home/default-clock",
      logger: { log() {}, error() {} },
    });

    const signal = JSON.parse(memory.files.get("/xdg-data/inbox/lead.jsonl")!.trim());
    expect(Number.isNaN(Date.parse(signal.ts))).toBe(false);
    expect(signal.msg).toBe("worktree tile-1 completed");
  });

  test("signalParentInbox writes to XDG data inbox when no home override is injected", () => {
    const memory = createMemoryFs();

    signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ], {
      fs: memory.fs,
      now: () => new Date("2026-05-17T02:03:04.005Z"),
      logger: { log() {}, error() {} },
    });

    const signal = JSON.parse(memory.files.get("/xdg-data/inbox/lead.jsonl")!.trim());
    expect(signal).toMatchObject({ from: "codex-agent", type: "done", msg: "worktree tile-1 completed" });
  });

  test("signalParentInbox keeps an explicit inboxDir override for harnesses", () => {
    const memory = createMemoryFs();

    signalParentInbox("tile-1", "work", [
      { name: "work", windows: [{ index: 0, name: "lead", active: true }] },
    ], {
      fs: memory.fs,
      inboxDir: "/tmp/custom-inbox",
      logger: { log() {}, error() {} },
    });

    expect(memory.files.has("/tmp/custom-inbox/lead.jsonl")).toBe(true);
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

  test("autoSave picks the retro form from the window's fleet engine (D3)", async () => {
    // codex worker → $rrr, from the fleet runtime.engine — NOT the pane command
    // (a codex pane reports its bash/node wrapper).
    const codex = createHarness({
      engine: "codex",
      hostExec: (command) => command.includes("pane_current_path") ? "/repo" : "",
    });
    await autoSave("tile-1", "work", {}, codex.deps);
    expect(codex.sent).toEqual([{ target: "work:tile-1", text: "$rrr" }]);
    expect(codex.sleeps).toEqual([10_000]);
    expect(codex.logs.join("\n")).toContain("$rrr sent (waited 10s)");

    // aider → no retrospective equivalent → skip the retro step.
    const aider = createHarness({
      engine: "aider",
      hostExec: (command) => command.includes("pane_current_path") ? "/repo" : "",
    });
    await autoSave("tile-1", "work", {}, aider.deps);
    expect(aider.sent).toEqual([]);
    expect(aider.sleeps).toEqual([]);
    expect(aider.logs.join("\n")).toContain("no retrospective command for this engine");
  });
});

describe("cleanupDoneBranch", () => {
  test("deletes branches that are ancestors of the configured base", async () => {
    const h = createHarness();

    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "feature/merged", {}, h.deps);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/merged' 'alpha'",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' branch -d 'feature/merged'",
    ]);
    expect(h.logs.join("\n")).toContain("deleted branch feature/merged (merged into alpha)");
  });

  test("deletes squash-merged branches only after merged PR proof", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
        if (command.startsWith("gh pr list")) return JSON.stringify([{ number: 1922 }]);
        return "";
      },
    });

    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "agents/1922-clean-branch", {}, h.deps);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'agents/1922-clean-branch' 'alpha'",
      "gh pr list --head 'agents/1922-clean-branch' --state merged --json number --limit 1",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' branch -D 'agents/1922-clean-branch'",
    ]);
    expect(h.logs.join("\n")).toContain("deleted branch agents/1922-clean-branch (merged PR)");
  });

  test("keeps branches when local proof fails and gh is unavailable", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
        if (command.startsWith("gh pr list")) throw new Error("gh unavailable");
        return "";
      },
    });

    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "feature/unverified", {}, h.deps);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/unverified' 'alpha'",
      "gh pr list --head 'feature/unverified' --state merged --json number --limit 1",
    ]);
    expect(h.logs.join("\n")).toContain("branch retained (feature/unverified): gh unavailable and not merged into alpha");
  });

  test("keeps unmerged branches when gh finds no merged PR", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
        if (command.startsWith("gh pr list")) return "[]";
        return "";
      },
    });

    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "feature/open", {}, h.deps);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/open' 'alpha'",
      "gh pr list --head 'feature/open' --state merged --json number --limit 1",
    ]);
    expect(h.logs.join("\n")).toContain("branch retained (feature/open): not merged into alpha and no merged PR found");
  });

  test("--clean-branch force-deletes without merge or PR proof", async () => {
    const h = createHarness();

    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "feature/force", { cleanBranch: true }, h.deps);

    expect(h.commands).toEqual([
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' branch -D 'feature/force'",
    ]);
    expect(h.logs.join("\n")).toContain("force-deleted branch feature/force");
  });

  test("uses alpha for maw-js and main for generic repositories", async () => {
    const maw = createHarness();
    await cleanupDoneBranch("/repos/github.com/Soul-Brews-Studio/maw-js", "feature/alpha", {}, maw.deps);
    expect(maw.commands[0]).toBe(
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/alpha' 'alpha'",
    );

    const generic = createHarness();
    await cleanupDoneBranch("/repos/github.com/acme/tool", "feature/main", {}, generic.deps);
    expect(generic.commands[0]).toBe(
      "git -C '/repos/github.com/acme/tool' merge-base --is-ancestor 'feature/main' 'main'",
    );
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
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1'",
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree prune",
    ]);
  });

  test("removeWorktreeViaConfig fails loud instead of force-removing dirty worktrees without --force", async () => {
    const h = createHarness({
      files: {
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "Soul-Brews-Studio/maw-js.wt-tile-1" }],
        }),
      },
      hostExec: (command) => {
        if (command.includes("rev-parse")) return "feature/dirty\n";
        if (command.includes("worktree remove")) throw new Error("fatal: contains modified or untracked files");
        if (command.includes("status --porcelain")) return "?? notes.txt\n";
        return "";
      },
    });

    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", h.deps)).rejects.toThrow(
      "has uncommitted changes; rerun maw done --force",
    );

    expect(h.commands).toContain(
      "git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1'",
    );
    expect(h.commands.some(command => command.includes("worktree remove") && command.includes("--force"))).toBe(false);
    expect(h.commands).not.toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree prune");
  });

  test("removeWorktreeViaConfig reads state fleet configs before duplicate legacy configs", async () => {
    const h = createHarness({
      files: {
        "/state/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "StateOrg/state-repo.wt-tile-1" }],
        }),
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "LegacyOrg/legacy-repo.wt-tile-1" }],
        }),
      },
      hostExec: (command) => {
        if (command.includes("rev-parse")) return "main\n";
        return "";
      },
    });
    h.deps.fleetDirs = ["/state/fleet", "/fleet"];

    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", h.deps)).resolves.toBe(true);

    expect(h.commands).toContain(
      "git -C '/repos/github.com/StateOrg/state-repo.wt-tile-1' rev-parse --abbrev-ref HEAD",
    );
    expect(h.commands.join("\n")).not.toContain("LegacyOrg/legacy-repo");
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
        if (command.startsWith("test -d")) throw new Error("missing");
        return "feature\n";
      },
    });
    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", removeFail.deps)).resolves.toBe(false);
    expect(removeFail.logs.join("\n")).toContain("worktree remove failed: busy");

    const scanFail = createHarness({ fsFailReaddir: true });
    await expect(removeWorktreeViaConfig("tile-1", "/repos/github.com", scanFail.deps)).resolves.toBe(false);
    expect(scanFail.errors.join("\n")).toContain("fleet scan failed");
  });

  test("removeWorktreeByGhqScan removes matching suffix worktrees and reports retained unmerged branches", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) {
          return [
            "/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1",
            "/repos/github.com/Soul-Brews-Studio/maw-js.wt-other",
          ].join("\n");
        }
        if (command.includes("rev-parse")) return "feature/scan\n";
        if (command.includes("merge-base --is-ancestor")) throw new Error("not merged");
        if (command.startsWith("gh pr list")) return "[]";
        return "";
      },
    });

    await expect(removeWorktreeByGhqScan("6-tile-1", "/repos/github.com", h.deps)).resolves.toBe(true);

    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1' rev-parse --abbrev-ref HEAD");
    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js' worktree remove '/repos/github.com/Soul-Brews-Studio/maw-js.wt-6-tile-1'");
    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/maw-js' merge-base --is-ancestor 'feature/scan' 'alpha'");
    expect(h.commands).toContain("gh pr list --head 'feature/scan' --state merged --json number --limit 1");
    expect(h.logs.join("\n")).toContain("removed worktree maw-js.wt-6-tile-1");
    expect(h.logs.join("\n")).toContain("branch retained (feature/scan): not merged into alpha and no merged PR found");
  });


  test("removeWorktreeByGhqScan refuses ambiguous cross-repo suffix matches", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) {
          return [
            "/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1",
            "/repos/github.com/Other/repo.wt-tile-1",
          ].join("\n");
        }
        throw new Error(`unexpected mutating command: ${command}`);
      },
    });

    await expect(removeWorktreeByGhqScan("x-tile-1", "/repos/github.com", h.deps)).resolves.toBe(false);

    expect(h.commands).toEqual(["find '/repos/github.com' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null"]);
    expect(h.errors.join("\n")).toContain("refusing to remove worktree 'tile-1' — matches 2 repos");
    expect(h.errors.join("\n")).toContain("/repos/github.com/Other/repo.wt-tile-1");
  });


  test("removeWorktreeByGhqScan uses caller cwd to disambiguate same-suffix worktrees", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) {
          return [
            "/repos/github.com/laris-co/ccc-oracle.wt-trio-coder",
            "/repos/github.com/Soul-Brews-Studio/mawjs-oracle/agents/1-trio-coder",
          ].join("\n");
        }
        if (command.includes("rev-parse --show-toplevel")) return "/repos/github.com/Soul-Brews-Studio/mawjs-oracle/agents/1-trio-coder\n";
        if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/trio\n";
        if (command.includes("merge-base --is-ancestor")) return "";
        return "";
      },
    });

    await expect(removeWorktreeByGhqScan("mawjs-trio-coder", "/repos/github.com", h.deps, { cwd: "/repos/github.com/Soul-Brews-Studio/mawjs-oracle" })).resolves.toBe(true);

    expect(h.logs.join("\n")).toContain("scoped ambiguous worktree 'trio-coder' to cwd repo /repos/github.com/Soul-Brews-Studio/mawjs-oracle");
    expect(h.commands).toContain("git -C '/repos/github.com/Soul-Brews-Studio/mawjs-oracle' worktree remove '/repos/github.com/Soul-Brews-Studio/mawjs-oracle/agents/1-trio-coder'");
    expect(h.commands.join("\n")).not.toContain("ccc-oracle.wt-trio-coder' --force");
  });

  test("removeWorktreeByGhqScan dry-run reports resolved worktrees without removing them", async () => {
    const h = createHarness({
      hostExec: (command) => {
        if (command.startsWith("find ")) return "/repos/github.com/Soul-Brews-Studio/maw-js.wt-tile-1\n";
        throw new Error(`dry-run should not run git mutation: ${command}`);
      },
    });

    await expect(removeWorktreeByGhqScan("x-tile-1", "/repos/github.com", h.deps, { dryRun: true })).resolves.toBe(true);

    expect(h.commands).toEqual(["find '/repos/github.com' -maxdepth 4 -type d \\( -name '*.wt-*' -o -path '*/agents/*' \\) 2>/dev/null"]);
    expect(h.logs.join("\n")).toContain("[dry-run] would remove worktree maw-js.wt-tile-1");
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
        if (command.startsWith("test -d")) throw new Error("missing");
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

  test("removeFromFleetConfig rewrites the state config before duplicate legacy files", () => {
    const h = createHarness({
      files: {
        "/state/fleet/team.json": JSON.stringify({
          windows: [
            { name: "tile-1", repo: "state/repo.wt-tile-1" },
            { name: "lead", repo: "state/repo" },
          ],
        }),
        "/fleet/team.json": JSON.stringify({
          windows: [{ name: "tile-1", repo: "legacy/repo.wt-tile-1" }],
        }),
      },
    });
    h.deps.fleetDirs = ["/state/fleet", "/fleet"];

    expect(removeFromFleetConfig("tile-1", h.deps)).toBe(true);

    expect(JSON.parse(h.files.get("/state/fleet/team.json")!)).toEqual({
      windows: [{ name: "lead", repo: "state/repo" }],
    });
    expect(JSON.parse(h.files.get("/fleet/team.json")!)).toEqual({
      windows: [{ name: "tile-1", repo: "legacy/repo.wt-tile-1" }],
    });
  });
});
