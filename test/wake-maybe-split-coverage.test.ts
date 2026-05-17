import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const realSdk = await import("../src/sdk");

let active = false;
let hostExecCalls: string[] = [];
let probeServerUp = true;
let listPanesResponse = "3\n";
let tileMarkerResponse = "";
let paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";
let throwOnSplit = false;
let throwOnRefresh = false;
let throwOnLayoutProbe = false;
let throwOnTileProbe = false;
let throwOnRespawn = false;
let throwOnNewWindow = false;

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string, ...args: unknown[]) => {
    if (!active) return realSdk.hostExec(cmd, ...(args as []));
    hostExecCalls.push(cmd);
    if (cmd === "tmux display-message -p '#S'") {
      if (!probeServerUp) throw new Error("no tmux server");
      return "work";
    }
    if (cmd.includes("split-window")) {
      if (throwOnSplit) throw new Error("split exploded");
      return "";
    }
    if (cmd.includes("refresh-client")) {
      if (throwOnRefresh) throw new Error("refresh unsupported");
      return "";
    }
    if (cmd.includes("show-options") && cmd.includes("@maw_tile")) {
      if (throwOnTileProbe) throw new Error("tile probe failed");
      return tileMarkerResponse;
    }
    if (cmd.includes("#{pane_id}|#{pane_top}|#{pane_left}|#{@maw_tile}")) {
      return paneGeometryResponse;
    }
    if (cmd.includes("list-panes") && cmd.includes("wc -l")) {
      if (throwOnLayoutProbe) throw new Error("layout probe failed");
      return listPanesResponse;
    }
    if (cmd.includes("respawn-pane")) {
      if (throwOnRespawn) throw new Error("respawn failed");
      return "";
    }
    if (cmd.includes("new-window")) {
      if (throwOnNewWindow) throw new Error("new window failed");
      return "";
    }
    return "";
  },
}));

const { findTopRightPane, maybeOpenWindow, maybeSplit, probeTmuxServer } =
  await import("../src/commands/shared/wake-maybe-split.ts?wake-maybe-split-coverage");

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
const originalLog = console.log;
let logs: string[] = [];

function output(): string {
  return logs.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function resetEnv(attached = true) {
  if (attached) process.env.TMUX = "/tmp/tmux-501/default,123,0";
  else delete process.env.TMUX;
  process.env.TMUX_PANE = "%42";
}

describe("wake maybe split/window coverage", () => {
  beforeEach(() => {
    active = true;
    hostExecCalls = [];
    logs = [];
    probeServerUp = true;
    listPanesResponse = "3\n";
    tileMarkerResponse = "";
    paneGeometryResponse = "%42|0|0|\n%43|0|81|1\n%44|26|81|1\n";
    throwOnSplit = false;
    throwOnRefresh = false;
    throwOnLayoutProbe = false;
    throwOnTileProbe = false;
    throwOnRespawn = false;
    throwOnNewWindow = false;
    resetEnv(true);
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
  });

  afterEach(() => {
    active = false;
    console.log = originalLog;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalPane;
  });

  test("probeTmuxServer reports true and false", async () => {
    await expect(probeTmuxServer()).resolves.toBe(true);
    probeServerUp = false;
    await expect(probeTmuxServer()).resolves.toBe(false);
  });

  test("maybeSplit is a no-op unless split is requested", async () => {
    await maybeSplit("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);
  });

  test("attached split restores layout, refreshes client, and shell-quotes targets", async () => {
    process.env.TMUX_PANE = "%4'2";
    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toContain("tmux split-window -t '%4'\\''2' -h -l 50%");
    expect(hostExecCalls[0]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[1]).toContain("show-options -p -t '%4'\\''2'");
    expect(hostExecCalls[2]).toContain("list-panes -t '%4'\\''2'");
    expect(hostExecCalls[3]).toContain("select-layout -t '%4'\\''2' main-vertical");
    expect(hostExecCalls[4]).toBe("tmux refresh-client -S");
    expect(output()).toContain("✓ split beside — 20-homekeeper:homekeeper-oracle (50%)");
  });

  test("split skips layout for two panes, tile anchors, invalid counts, and layout probe failures", async () => {
    listPanesResponse = "2\n";
    await maybeSplit("two:pane", { split: true });
    expect(hostExecCalls.some(cmd => cmd.includes("select-layout"))).toBe(false);

    hostExecCalls = [];
    tileMarkerResponse = "1\n";
    await maybeSplit("tile:pane", { split: true });
    expect(hostExecCalls.some(cmd => cmd.includes("select-layout"))).toBe(false);

    hostExecCalls = [];
    tileMarkerResponse = "";
    listPanesResponse = "not-a-number\n";
    await maybeSplit("bad:count", { split: true });
    expect(hostExecCalls.some(cmd => cmd.includes("select-layout"))).toBe(false);

    hostExecCalls = [];
    throwOnLayoutProbe = true;
    await maybeSplit("probe:fails", { split: true });
    expect(output()).toContain("✓ split beside — probe:fails (50%)");
  });

  test("split handles no pane anchor, high pane count, tile probe errors, refresh errors, and split failures", async () => {
    delete process.env.TMUX_PANE;
    listPanesResponse = "5\n";
    await maybeSplit("no:anchor", { split: true });
    expect(hostExecCalls[0]).toContain("tmux split-window -h -l 50%");
    expect(hostExecCalls.some(cmd => cmd.includes("select-layout tiled"))).toBe(true);

    resetEnv(true);
    hostExecCalls = [];
    throwOnTileProbe = true;
    throwOnRefresh = true;
    await maybeSplit("probe:refresh", { split: true });
    expect(hostExecCalls.some(cmd => cmd.includes("show-options"))).toBe(true);
    expect(hostExecCalls.at(-1)).toBe("tmux refresh-client -S");

    hostExecCalls = [];
    logs = [];
    throwOnSplit = true;
    await maybeSplit("fail:split", { split: true });
    expect(output()).toContain("⚠ split failed: split exploded");
  });

  test("headless split distinguishes running and missing tmux server", async () => {
    resetEnv(false);
    await maybeSplit("created:target", { split: true });
    expect(output()).toContain("--split skipped — shell is not attached to a tmux pane");
    expect(output()).toContain("tmux attach -t created");

    logs = [];
    probeServerUp = false;
    await maybeSplit("missing:target", { split: true });
    expect(output()).toContain("--split skipped — tmux server not running");
    expect(output()).toContain("tmux new -s work");
  });

  test("findTopRightPane prefers marked tile panes and falls back to all panes", async () => {
    await expect(findTopRightPane()).resolves.toBeNull();
    await expect(findTopRightPane("%42")).resolves.toBe("%43");

    paneGeometryResponse = "%42|0|0|\ninvalid\n%50|4|10|\n%51|0|20|\n%52|0|30|\n";
    await expect(findTopRightPane("%42")).resolves.toBe("%52");

    paneGeometryResponse = "%42|0|0|\n";
    await expect(findTopRightPane("%42")).resolves.toBeNull();
  });

  test("maybeOpenWindow replaces top-right pane, opens tabs, and handles bring no-op", async () => {
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", {});
    expect(hostExecCalls).toEqual([]);

    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });
    expect(hostExecCalls.at(-1)).toContain("tmux respawn-pane -k -t '%43'");
    expect(output()).toContain("✓ replaced top-right pane — 20-homekeeper:homekeeper-oracle");

    hostExecCalls = [];
    logs = [];
    paneGeometryResponse = "%42|0|0|\n";
    await maybeOpenWindow("20-homekeeper:homekeeper-oracle", { bring: true });
    expect(hostExecCalls.at(-1)).toContain("tmux new-window -d -n 'bring-homekeeper-oracle'");
    expect(output()).toContain("✓ opened background tab — 20-homekeeper:homekeeper-oracle");

    hostExecCalls = [];
    await maybeOpenWindow("sess:win/name with spaces", { bring: true, tab: true });
    expect(hostExecCalls[0]).toContain("-n 'bring-win-name-with-spaces'");
  });

  test("maybeOpenWindow reports failures from pane replacement and background tabs", async () => {
    throwOnRespawn = true;
    await maybeOpenWindow("replace:fails", { bring: true });
    expect(output()).toContain("⚠ bring failed: respawn failed");

    logs = [];
    hostExecCalls = [];
    throwOnRespawn = false;
    paneGeometryResponse = "%42|0|0|\n";
    throwOnNewWindow = true;
    await maybeOpenWindow("tab:fails", { bring: true });
    expect(output()).toContain("⚠ bring failed: new window failed");
  });

  test("headless bring distinguishes running and missing tmux server", async () => {
    resetEnv(false);
    await maybeOpenWindow("created:target", { bring: true });
    expect(output()).toContain("bring skipped — shell is not attached to a tmux pane");
    expect(output()).toContain("tmux attach -t created");

    logs = [];
    probeServerUp = false;
    await maybeOpenWindow("missing:target", { bring: true });
    expect(output()).toContain("bring skipped — tmux server not running");
    expect(output()).toContain("tmux new -s work");
  });
});
