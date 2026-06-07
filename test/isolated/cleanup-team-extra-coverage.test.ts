import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const fleetLoadPath = import.meta.resolve("../../src/commands/shared/fleet-load.ts");

let panes: any[] = [];
let killPaneCalls: string[] = [];
let fleetEntries: Array<{ file: string }> = [];
let logs: string[] = [];
let stdoutWrites: string[] = [];

const originalLog = console.log;
const originalMawTestMode = process.env.MAW_TEST_MODE;
const originalCwd = process.cwd();
const originalStdoutWrite = process.stdout.write;
const originalBunSleep = Bun.sleep;

mock.module("maw-js/sdk", () => ({
  tmux: {
    listPanes: async () => panes,
    killPane: async (paneId: string) => {
      killPaneCalls.push(paneId);
    },
  },
}));

mock.module(fleetLoadPath, () => ({
  loadFleetEntries: () => fleetEntries,
}));

const helpers = await import("../../src/vendor/mpr-plugins/cleanup/internal/team-helpers.ts");
const zombies = await import("../../src/vendor/mpr-plugins/cleanup/internal/team-cleanup-zombies.ts?cleanup-team-extra");
const {
  _setDirs,
  cleanupTeamDir,
  loadTeam,
  resolvePsi,
  writeMessage,
  writeShutdownRequest,
} = helpers;
const { cmdCleanupZombies, findZombiePanes } = zombies;

type Pane = {
  id: string;
  target: string;
  command?: string;
  title?: string;
  session: string;
  window: string;
};

const pane = (id: string, target: string, command = "claude", title = id): Pane => ({
  id,
  target,
  command,
  title,
  session: target.split(":")[0] ?? "",
  window: target.split(":")[1]?.split(".")[0] ?? "",
});

let root = "";
let teamsDir = "";
let tasksDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-cleanup-team-extra-"));
  teamsDir = join(root, "teams");
  tasksDir = join(root, "tasks");
  _setDirs(teamsDir, tasksDir);
  panes = [];
  killPaneCalls = [];
  fleetEntries = [];
  logs = [];
  stdoutWrites = [];
  process.env.MAW_TEST_MODE = "1";
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  Bun.sleep = (async () => undefined) as typeof Bun.sleep;
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalStdoutWrite;
  Bun.sleep = originalBunSleep;
  if (originalMawTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalMawTestMode;
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("cleanup team helper extra coverage", () => {
  test("loads teams defensively, resolves psi upward, writes inbox messages, and removes team state", () => {
    expect(loadTeam("missing")).toBeNull();

    mkdirSync(join(teamsDir, "valid"), { recursive: true });
    writeFileSync(join(teamsDir, "valid", "config.json"), JSON.stringify({
      name: "valid",
      members: [{ name: "one", tmuxPaneId: "%1" }],
    }));
    expect(loadTeam("valid")?.members[0]?.tmuxPaneId).toBe("%1");

    mkdirSync(join(teamsDir, "broken"), { recursive: true });
    writeFileSync(join(teamsDir, "broken", "config.json"), "{broken");
    expect(loadTeam("broken")).toBeNull();

    const project = join(root, "oracle-root");
    const nested = join(project, "packages", "cli");
    mkdirSync(join(project, "ψ"), { recursive: true });
    writeFileSync(join(project, "CLAUDE.md"), "oracle marker");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(resolvePsi()).toBe(realpathSync(join(project, "ψ")));

    const fallback = join(root, "not-an-oracle");
    mkdirSync(fallback, { recursive: true });
    process.chdir(fallback);
    expect(resolvePsi()).toBe(join(realpathSync(fallback), "ψ"));

    mkdirSync(join(teamsDir, "valid", "inboxes"), { recursive: true });
    writeFileSync(join(teamsDir, "valid", "inboxes", "one.json"), "not json");
    writeShutdownRequest("valid", "one", "done for now");
    let messages = JSON.parse(readFileSync(join(teamsDir, "valid", "inboxes", "one.json"), "utf-8"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: "maw-team-shutdown",
      summary: "Shutdown request: done for now",
      read: false,
    });
    expect(JSON.parse(messages[0].text)).toMatchObject({
      type: "shutdown_request",
      reason: "done for now",
    });

    writeShutdownRequest("valid", "one", "second request");
    messages = JSON.parse(readFileSync(join(teamsDir, "valid", "inboxes", "one.json"), "utf-8"));
    expect(messages).toHaveLength(2);

    writeMessage("valid", "two", "leader", "hello teammate".repeat(8));
    const direct = JSON.parse(readFileSync(join(teamsDir, "valid", "inboxes", "two.json"), "utf-8"));
    expect(direct).toHaveLength(1);
    expect(direct[0].summary).toHaveLength(80);
    expect(JSON.parse(direct[0].text)).toEqual({
      type: "message",
      content: "hello teammate".repeat(8),
    });

    writeFileSync(join(teamsDir, "valid", "inboxes", "two.json"), "not json either");
    writeMessage("valid", "two", "leader", "fresh after corrupt inbox");
    const recovered = JSON.parse(readFileSync(join(teamsDir, "valid", "inboxes", "two.json"), "utf-8"));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ from: "leader", summary: "fresh after corrupt inbox" });

    mkdirSync(join(tasksDir, "valid"), { recursive: true });
    writeFileSync(join(tasksDir, "valid", "task.json"), "{}");
    cleanupTeamDir("valid");
    expect(existsSync(join(teamsDir, "valid"))).toBe(false);
    expect(existsSync(join(tasksDir, "valid"))).toBe(false);
  });
});

describe("cleanup zombie command extra coverage", () => {
  test("classifies fleet, registry, linked-safe, primary, and orphan panes", () => {
    mkdirSync(join(teamsDir, "kept"), { recursive: true });
    writeFileSync(join(teamsDir, "kept", "config.json"), JSON.stringify({
      name: "kept",
      members: [
        { name: "active", tmuxPaneId: "%team" },
        { name: "inline", tmuxPaneId: "in-process" },
        { name: "empty", tmuxPaneId: "" },
      ],
    }));
    mkdirSync(join(teamsDir, "broken"), { recursive: true });
    writeFileSync(join(teamsDir, "broken", "config.json"), "{bad");
    mkdirSync(join(root, ".config", "maw"), { recursive: true });
    writeFileSync(join(root, ".config", "maw", "oracles.json"), JSON.stringify({
      oracles: [{ name: "registered" }, { name: "" }, { ignored: true }],
    }));

    const oldHome = process.env.HOME;
    process.env.HOME = root;
    try {
      fleetEntries = [{ file: "01-pulse.json" }];
      const found = findZombiePanes([
        pane("%team", "dead-team:2.1", "claude", "known team"),
        pane("%fleet", "01-pulse:2.0", "claude", "fleet"),
        pane("%view", "maw-view:1.0", "claude", "maw view"),
        pane("%otherView", "random-view:1.0", "claude", "other view"),
        pane("%registry", "28-registered:4.1", "claude", "registry"),
        pane("%linked", "01-pulse:3.0", "claude", "safe fleet target"),
        pane("%linked", "deleted:3.0", "claude", "same id as a safe target"),
        pane("%primaryIndex", "scratch:1.0", "claude", "primary indexed"),
        pane("%primaryNamed", "scratch:agent-oracle.0", "claude", "primary named"),
        pane("%shell", "deleted:4.0", "zsh", "not claude"),
        pane("%zombie", "deleted:5.2", "claude", "orphan title"),
      ] as any[]);

      expect(found).toEqual([
        { paneId: "%registry", info: '28-registered:4.1  "registry"', teamName: "unknown" },
        { paneId: "%zombie", info: 'deleted:5.2  "orphan title"', teamName: "unknown" },
      ]);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  test("reports no zombies, previews zombies, and kills after the abort-window preview", async () => {
    panes = [pane("%safe", "maw-view:1.0", "claude", "safe view")];
    await cmdCleanupZombies();
    expect(logs.join("\n")).toContain("No zombie agent panes found");
    expect(killPaneCalls).toEqual([]);

    logs = [];
    panes = [pane("%z1", "dead:2.0", "claude", "zombie one")];
    await cmdCleanupZombies();
    expect(logs.join("\n")).toContain("1");
    expect(logs.join("\n")).toContain("--yes");
    expect(killPaneCalls).toEqual([]);

    logs = [];
    stdoutWrites = [];
    delete process.env.MAW_TEST_MODE;
    await cmdCleanupZombies({ yes: true });
    expect(killPaneCalls).toEqual(["%z1"]);
    expect(logs.join("\n")).toContain("Killing");
    expect(logs.join("\n")).toContain("killed %z1");
    expect(stdoutWrites.join("")).toContain("3...");
    expect(stdoutWrites.join("")).toContain("1...");
  });
});
