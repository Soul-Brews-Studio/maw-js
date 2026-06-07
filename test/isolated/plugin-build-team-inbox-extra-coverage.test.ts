/**
 * Extra isolated unit coverage for plugin build + team inbox/layout helpers.
 * @maw-test-isolate @maw-test-isolate-cwd-neutral
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cmdPluginBuild } from "../../src/commands/plugins/plugin/build-impl";
import {
  markRead,
  readInbox,
  readUnread,
  sendDone,
  sendProgress,
  sendShutdown,
  sendStuck,
  writeInboxMessage,
  type InboxMessage,
} from "../../src/commands/plugins/team/inbox";
import {
  loadLayoutSnapshot,
  saveLayoutSnapshot,
  type LayoutSnapshot,
} from "../../src/commands/plugins/team/layout-snapshot";
import { _setDirs } from "../../src/commands/plugins/team/team-helpers";

const created: string[] = [];
let teamsDir = "";
let tasksDir = "";

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  teamsDir = tmpDir("maw-extra-teams-");
  tasksDir = tmpDir("maw-extra-tasks-");
  _setDirs(teamsDir, tasksDir);
});

afterEach(() => {
  delete process.env.MAW_PLUGIN_CAP_INFER;
  for (const dir of created.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldPlugin(
  dir: string,
  opts: {
    name?: string;
    version?: string;
    target?: string;
    entry?: string;
    source?: string;
    capabilities?: string[];
    pluginJson?: string;
  } = {},
): void {
  if (opts.pluginJson !== undefined) {
    writeFileSync(join(dir, "plugin.json"), opts.pluginJson);
    return;
  }

  const entry = opts.entry ?? "./src/index.ts";
  const srcPath = join(dir, entry);
  mkdirSync(srcPath.slice(0, srcPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    srcPath,
    opts.source ?? "export default async () => ({ ok: true, output: 'hi' });\n",
  );
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: opts.name ?? "fixture",
        version: opts.version ?? "0.1.0",
        sdk: "^1.0.0",
        target: opts.target ?? "js",
        entry,
        artifact: { path: "dist/index.js", sha256: null },
        capabilities: opts.capabilities ?? [],
      },
      null,
      2,
    ) + "\n",
  );
}

async function captureConsole(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("plugin build implementation extra branches", () => {
  test("rejects invalid plugin.json with parse error context", async () => {
    const dir = tmpDir("maw-plugin-invalid-json-");
    scaffoldPlugin(dir, { pluginJson: "{ nope" });

    await expect(cmdPluginBuild([dir])).rejects.toThrow(/invalid plugin\.json/);
  });

  test("rejects unknown non-js targets before building", async () => {
    const dir = tmpDir("maw-plugin-unknown-target-");
    scaffoldPlugin(dir, { target: "native" });

    await expect(cmdPluginBuild([dir])).rejects.toThrow(/unknown target "native"/);
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(false);
  });

  test("rejects missing entry files", async () => {
    const dir = tmpDir("maw-plugin-missing-entry-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify(
        {
          name: "missing-entry",
          version: "0.1.0",
          target: "js",
          entry: "./src/missing.ts",
          capabilities: [],
        },
        null,
        2,
      ),
    );

    await expect(cmdPluginBuild([dir])).rejects.toThrow(/entry not found:/);
  });

  test("surfaces bun build failures", async () => {
    const dir = tmpDir("maw-plugin-bundle-fail-");
    scaffoldPlugin(dir, { source: "export default () => {\n" });

    await expect(cmdPluginBuild([dir])).rejects.toThrow(/bundle failed:/);
  });

  test("surfaces tarball packing failures", async () => {
    const dir = tmpDir("maw-plugin-tar-fail-");
    scaffoldPlugin(dir, { name: "nested/name" });

    await expect(cmdPluginBuild([dir])).rejects.toThrow(/tarball packing failed:/);
  });

  test("prints inferred-only and declared-only capability deltas", async () => {
    const dir = tmpDir("maw-plugin-cap-deltas-");
    process.env.MAW_PLUGIN_CAP_INFER = "regex";
    scaffoldPlugin(dir, {
      capabilities: ["manual:declared"],
      source:
        "const maw: any = { identity() { return 'id'; } };\n" +
        "maw.identity();\n" +
        "export default async () => ({ ok: true });\n",
    });

    const { stdout } = await captureConsole(() => cmdPluginBuild([dir]));
    const manifest = readJson(join(dir, "dist", "plugin.json"));

    expect(manifest.capabilities).toEqual(["manual:declared", "sdk:identity"]);
    expect(stdout).toContain("+ inferred (not declared):");
    expect(stdout).toContain("sdk:identity");
    expect(stdout).toContain("- declared (not detected):");
    expect(stdout).toContain("manual:declared");
  });
});

describe("team inbox helpers", () => {
  test("writeInboxMessage writes atomically named JSON and readInbox sorts visible valid files", () => {
    const path = writeInboxMessage("brew", "alice", {
      type: "status",
      from: "leader",
      to: "alice",
      payload: { mood: "green" },
    });

    expect(path).toMatch(/status\.json$/);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(teamsDir, "brew", "inboxes", "alice")).some((f) => f.endsWith(".tmp"))).toBe(false);

    const stored = readJson(path) as InboxMessage;
    expect(stored.timestamp).toEqual(expect.any(Number));
    expect(stored.payload).toEqual({ mood: "green" });
  });

  test("readUnread and markRead ignore hidden/corrupt messages and persist unread changes", () => {
    const inboxDir = join(teamsDir, "brew", "inboxes", "leader");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, "100-progress.json"),
      JSON.stringify({ type: "progress", from: "a", to: "leader", timestamp: 100, payload: {}, read: false }),
    );
    writeFileSync(
      join(inboxDir, "200-done.json"),
      JSON.stringify({ type: "done", from: "b", to: "leader", timestamp: 200, payload: {}, read: true }),
    );
    writeFileSync(join(inboxDir, ".300-hidden.json"), JSON.stringify({ type: "status" }));
    writeFileSync(join(inboxDir, "400-corrupt.json"), "{ nope");

    expect(readInbox("brew", "leader").map((m) => m.type)).toEqual(["progress", "done"]);
    expect(readUnread("brew", "leader").map((m) => m.from)).toEqual(["a"]);
    expect(markRead("brew", "leader")).toBe(1);
    expect(readJson(join(inboxDir, "100-progress.json")).read).toBe(true);
    expect(markRead("brew", "leader")).toBe(0);
  });

  test("convenience send helpers address leader and workers with expected payloads", () => {
    const progressPath = sendProgress("brew", "worker-a", "halfway");
    const donePath = sendDone("brew", "worker-a", "finished");
    const stuckPath = sendStuck("brew", "worker-b", "blocked");
    const shutdownPath = sendShutdown("brew", "worker-b", "wrap up");

    expect(readJson(progressPath)).toMatchObject({
      type: "progress",
      from: "worker-a",
      to: "leader",
      payload: { status: "halfway" },
    });
    expect(readJson(donePath)).toMatchObject({
      type: "done",
      from: "worker-a",
      to: "leader",
      payload: { summary: "finished" },
    });
    expect(readJson(stuckPath)).toMatchObject({
      type: "stuck",
      from: "worker-b",
      to: "leader",
      payload: { reason: "blocked" },
    });
    expect(readJson(shutdownPath)).toMatchObject({
      type: "shutdown",
      from: "leader",
      to: "worker-b",
      payload: { reason: "wrap up" },
    });
  });
});

function writeTeamConfig(teamName: string, members: unknown[]): void {
  const teamDir = join(teamsDir, teamName);
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(
    join(teamDir, "config.json"),
    JSON.stringify({ name: teamName, members }, null, 2),
  );
}

describe("team layout snapshots", () => {
  test("saveLayoutSnapshot no-ops when the team config is missing", () => {
    saveLayoutSnapshot("missing", "%0");

    expect(existsSync(join(teamsDir, "missing", "layout.json"))).toBe(false);
  });

  test("saveLayoutSnapshot filters non-worker panes and fills defaults", () => {
    writeTeamConfig("brew", [
      { name: "lead", agentType: "team-lead", tmuxPaneId: "%0", color: "red" },
      { name: "idle", agentType: "executor", color: "green" },
      { name: "worker-a", agentType: "executor", agentId: "agent-a", tmuxPaneId: "%1", color: "yellow" },
      { name: "worker-b", agentType: "executor", tmuxPaneId: "%2" },
    ]);

    saveLayoutSnapshot("brew", "%0", "tiled");
    const snapshot = loadLayoutSnapshot("brew") as LayoutSnapshot;

    expect(snapshot).toMatchObject({ teamName: "brew", leaderPane: "%0", layout: "tiled" });
    expect(snapshot.savedAt).toEqual(expect.any(Number));
    expect(snapshot.panes).toEqual([
      { name: "worker-a", agentId: "agent-a", tmuxPaneId: "%1", color: "yellow" },
      { name: "worker-b", agentId: "worker-b@brew", tmuxPaneId: "%2", color: "blue" },
    ]);
  });

  test("loadLayoutSnapshot returns null for missing or corrupt files", () => {
    expect(loadLayoutSnapshot("none")).toBeNull();

    mkdirSync(join(teamsDir, "corrupt"), { recursive: true });
    writeFileSync(join(teamsDir, "corrupt", "layout.json"), "{ nope");

    expect(loadLayoutSnapshot("corrupt")).toBeNull();
  });
});
