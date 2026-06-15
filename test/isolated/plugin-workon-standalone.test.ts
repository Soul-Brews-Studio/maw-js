import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type Worktree = { path: string; name: string };

let ghqResult = "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle";
let worktrees: Worktree[] = [];
let hostExecCalls: string[] = [];
let newWindowCalls: Array<{ session: string; name: string; opts: unknown }> = [];
let sendTextCalls: Array<{ target: string; text: string }> = [];
let selectWindowCalls: string[] = [];
let windows: Array<{ name: string }> = [];
let fleetEntries: Array<{ session: string; window: string; cwd: string; createdBy: string }> = [];
let fleetStatus: "created" | "updated" = "created";

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (command.includes("display-message")) return "mawjs\n";
    return "";
  },
  tmux: {
    listWindows: async () => windows,
    newWindow: async (session: string, name: string, opts: unknown) => {
      newWindowCalls.push({ session, name, opts });
    },
    sendText: async (target: string, text: string) => {
      sendTextCalls.push({ target, text });
    },
    selectWindow: async (target: string) => {
      selectWindowCalls.push(target);
    },
  },
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async () => ghqResult,
}));

mock.module("maw-js/config", () => ({
  buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && agent --name ${name}`,
}));

mock.module("maw-js/commands/shared/wake", () => ({
  findWorktrees: async () => worktrees,
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveWorktreeTarget: (task: string, candidates: Worktree[]) => {
    const exact = candidates.find((candidate) => candidate.name === task || candidate.name.endsWith(`-${task}`));
    return exact ? { kind: "exact", match: exact } : { kind: "none" };
  },
}));

mock.module("maw-js/core/fleet/worktree-layout", () => ({
  normalizeWorktreeLayout: (layout?: "nested" | "legacy") => layout ?? "nested",
  worktreePathForLayout: ({ repoPath, repoName, wtName, layout }: any) => (
    layout === "legacy" ? `/opt/Code/github.com/Soul-Brews-Studio/${repoName}.wt-${wtName}` : `${repoPath}/agents/${wtName}`
  ),
}));

mock.module("maw-js/commands/shared/fleet-ensure", () => ({
  ensureFleetSessionEntry: (entry: { session: string; window: string; cwd: string; createdBy: string }) => {
    fleetEntries.push(entry);
    return { status: fleetStatus };
  },
}));

const { default: workonHandler } = await import("../../src/vendor/mpr-plugins/workon/index.ts?plugin-workon-standalone");
const { cmdWorkon, sanitizeWorkonTaskSlug } = await import("../../src/vendor/mpr-plugins/workon/impl.ts?plugin-workon-standalone");

beforeEach(() => {
  process.env.TMUX = "/tmp/tmux.sock,1,0";
  ghqResult = "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle";
  worktrees = [];
  hostExecCalls = [];
  newWindowCalls = [];
  sendTextCalls = [];
  selectWindowCalls = [];
  windows = [];
  fleetEntries = [];
  fleetStatus = "created";
});

describe("workon plugin standalone boundary (#2316)", () => {
  test("documents the current host-boundary imports while covering the new fleet registration dependency", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "workon",
      root,
      allowMawJs: [
        "maw-js/core/ghq",
        "maw-js/config",
        "maw-js/commands/shared/wake",
        "maw-js/commands/shared/fleet-ensure",
        "maw-js/core/matcher/resolve-target",
        "maw-js/core/fleet/worktree-layout",
      ],
      allowRelative: [/^\.\/impl$/],
    });

    expect(imports.map((record) => record.spec)).toContain("maw-js/commands/shared/fleet-ensure");
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
  });

  test("opens an oracle repo window and registers it in the fleet when no task is supplied", async () => {
    await cmdWorkon("mawjs-oracle");

    expect(newWindowCalls).toEqual([
      { session: "mawjs", name: "mawjs-oracle", opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle" } },
    ]);
    expect(sendTextCalls).toEqual([
      {
        target: "mawjs:mawjs-oracle",
        text: "cd /opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle && agent --name mawjs-oracle",
      },
    ]);
    expect(fleetEntries).toEqual([
      {
        session: "mawjs",
        window: "mawjs-oracle",
        cwd: "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle",
        createdBy: "maw workon",
      },
    ]);
  });

  test("does not register fleet entries for task worktrees or existing windows", async () => {
    worktrees = [{ name: "3-ship-fix", path: "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle/agents/3-ship-fix" }];

    await cmdWorkon("mawjs-oracle", "ship-fix");

    expect(newWindowCalls[0]).toEqual({
      session: "mawjs",
      name: "mawjs-oracle-ship-fix",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle/agents/3-ship-fix" },
    });
    expect(fleetEntries).toEqual([]);

    windows = [{ name: "mawjs-oracle" }];
    newWindowCalls = [];
    sendTextCalls = [];
    await cmdWorkon("mawjs-oracle");

    expect(selectWindowCalls).toEqual(["mawjs:mawjs-oracle"]);
    expect(newWindowCalls).toEqual([]);
    expect(sendTextCalls).toEqual([]);
    expect(fleetEntries).toEqual([]);
  });

  test("handler validates usage, layout, and forwards sanitized task worktree creation", async () => {
    expect(sanitizeWorkonTaskSlug("bug/fix")).toBe("bug-fix");

    await expect(workonHandler({ source: "cli", args: [] } as any)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("usage: maw workon"),
    });
    await expect(workonHandler({ source: "cli", args: ["mawjs-oracle", "ship", "--layout", "bad"] } as any)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("--layout must be nested or legacy"),
    });

    const ok = await workonHandler({ source: "cli", args: ["mawjs-oracle", "bug/fix", "--layout", "legacy"] } as any);

    expect(ok.ok).toBe(true);
    expect(hostExecCalls).toContain("git -C '/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle' worktree add '/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle.wt-1-bug-fix' -b 'agents/1-bug-fix'");
    expect(newWindowCalls.at(-1)).toEqual({
      session: "mawjs",
      name: "mawjs-oracle-bug-fix",
      opts: { cwd: "/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle.wt-1-bug-fix" },
    });
  });
});
