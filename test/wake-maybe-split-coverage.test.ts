import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const realSdk = await import("../src/sdk");

let active = false;
// kobo-483: fail-closed, same pattern as wake-cmd-cmdwake-coverage.test.ts —
// found via searching for the actual hostExec/`real*` call target, not this
// file's toggle name (it's `active`, not `mockActive` — the earlier grep
// pass missed it for exactly that reason).
let suiteStarted = false;

function realCallForbidden(label: string): never {
  throw new Error(
    `[kobo-483 fail-closed] "${label}" was called with the mock inactive after the ` +
    `test suite had already started — refusing to fall through to the real ` +
    `implementation. Fix the race, don't restore the real passthrough.`,
  );
}

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
let paneCommandResponse = "zsh";
let paneSessionWindowResponse = "";
let paneClientTtyResponse = "/dev/ttys001";
let newWindowResponse = "";

mock.module(join(import.meta.dir, "../src/sdk"), () => ({
  ...realSdk,
  hostExec: async (cmd: string, ...args: unknown[]) => {
    if (!active) {
      if (!suiteStarted) return realSdk.hostExec(cmd, ...(args as []));
      return realCallForbidden("hostExec");
    }
    hostExecCalls.push(cmd);
    if (cmd.includes("pane_current_command")) return paneCommandResponse;
    if (cmd.includes("session_name") && cmd.includes("window_name")) return paneSessionWindowResponse;
    if (cmd.includes("client_tty")) return paneClientTtyResponse;
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
      return newWindowResponse;
    }
    return "";
  },
}));

const { findTopRightPane, maybeOpenWindow, maybeSplit, probeTmuxServer } =
  await import("../src/commands/shared/wake-maybe-split.ts?wake-maybe-split-coverage");

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
const originalForceSplit = process.env.MAW_FORCE_SPLIT;
const originalSafeSplit = process.env.MAW_SAFE_SPLIT;
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
    suiteStarted = true; // kobo-483: never reset — marks "past the safe module-load window"
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
    paneCommandResponse = "zsh";
    paneSessionWindowResponse = "";
    paneClientTtyResponse = "/dev/ttys001";
    newWindowResponse = "";
    delete process.env.MAW_ALLOW_SELF_BRING;
    delete process.env.MAW_FORCE_SPLIT;
    delete process.env.MAW_SAFE_SPLIT;
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
    if (originalForceSplit === undefined) delete process.env.MAW_FORCE_SPLIT;
    else process.env.MAW_FORCE_SPLIT = originalForceSplit;
    if (originalSafeSplit === undefined) delete process.env.MAW_SAFE_SPLIT;
    else process.env.MAW_SAFE_SPLIT = originalSafeSplit;
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

    // #1816 — self-bring guard reads caller's session:window first (mock returns "" → no match → proceed).
    expect(hostExecCalls[0]).toContain("session_name}:#{window_name");
    expect(hostExecCalls[1]).toContain("pane_current_command");
    expect(hostExecCalls[2]).toContain("tmux split-window -t '%4'\\''2' -h -l 50%");
    expect(hostExecCalls[2]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls[3]).toContain("show-options -p -t '%4'\\''2'");
    expect(hostExecCalls[4]).toContain("list-panes -t '%4'\\''2'");
    expect(hostExecCalls[5]).toContain("select-layout -t '%4'\\''2' main-vertical");
    expect(hostExecCalls[6]).toBe("tmux refresh-client -S");
    expect(output()).toContain("✓ split beside — 20-homekeeper:homekeeper-oracle (50%)");
  });


  test("#1816 — split refuses when target equals caller's session:window (self-bring loop guard)", async () => {
    paneSessionWindowResponse = "20-homekeeper:homekeeper-oracle";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    // First call: session:window probe. No further tmux side-effects.
    expect(hostExecCalls).toHaveLength(1);
    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(output()).toContain("refusing to split-bring oracle into its own pane");
    expect(output()).toContain("MAW_ALLOW_SELF_BRING=1");
    expect(output()).not.toContain("✓ split beside");
  });

  test("#1816 — MAW_ALLOW_SELF_BRING=1 overrides the self-bring guard", async () => {
    paneSessionWindowResponse = "20-homekeeper:homekeeper-oracle";
    process.env.MAW_ALLOW_SELF_BRING = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window -t '%42' -h -l 50%"))).toBe(true);
    expect(output()).toContain("✓ split beside");
    expect(output()).not.toContain("refusing to split-bring");
  });

  test("#1909 — same-session different-window moves the target pane via join-pane (multi-pane source)", async () => {
    paneSessionWindowResponse = "20-homekeeper:homekeeper-oracle";

    await maybeSplit("20-homekeeper:homekeeper-bridge", { split: true });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '%42' '#{pane_current_command}'");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux join-pane -h -l 50% -s '20-homekeeper:homekeeper-bridge' -t '%42'"))).toBe(true);
    expect(output()).toContain("✓ joined beside — 20-homekeeper:homekeeper-bridge (same-session move; active pane)");
    expect(output()).toContain("other panes remain in source window");
    expect(output()).not.toContain("same-session --split unsupported");
    expect(output()).not.toContain("✓ split beside");
  });

  test("#1909 — same-session move emits 'window auto-destroyed' warning when source is the last pane", async () => {
    paneSessionWindowResponse = "20-homekeeper:homekeeper-oracle";
    listPanesResponse = "1\n";

    await maybeSplit("20-homekeeper:homekeeper-bridge", { split: true });

    expect(hostExecCalls.some(cmd => cmd.includes("tmux join-pane -h -l 50% -s '20-homekeeper:homekeeper-bridge' -t '%42'"))).toBe(true);
    expect(output()).toContain("✓ joined beside — 20-homekeeper:homekeeper-bridge (same-session move; active pane)");
    expect(output()).toContain("source window 'homekeeper-bridge' removed");
    expect(output()).toContain("pane was the last; window auto-destroyed");
    expect(output()).toContain("restore later: tmux break-pane");
  });

  // Note: Q1 (bare-session same-session refuse with explicit-window hint) is
  // defensive code in the new branch but unreachable in practice: bare same-
  // session targets are caught earlier by isSelfBring (#1816, bring-flags.ts:99).
  // The Q1 path stays as belt-and-suspenders for any future refactor that
  // reorders the guards.

  test("#1816 — splitTarget anchors the split in a destination session:window", async () => {
    await maybeSplit("50-mawjs:mawjs-features", {
      split: true,
      splitTarget: "50-mawjs:maw-js-1816",
    });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '50-mawjs:maw-js-1816' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '50-mawjs:maw-js-1816' '#{pane_current_command}'");
    expect(hostExecCalls[2]).toContain("tmux split-window -t '50-mawjs:maw-js-1816' -h -l 50%");
    expect(output()).toContain("✓ split beside — 50-mawjs:mawjs-features (50%)");
  });

  test("MAW_SAFE_SPLIT keeps Claude-like caller panes on the background-tab path (#1836)", async () => {
    paneCommandResponse = "2.1.139";
    newWindowResponse = "@88";
    process.env.MAW_SAFE_SPLIT = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '%42' '#{pane_current_command}'");
    expect(hostExecCalls[2]).toBe("tmux send-keys -R -t '%42' C-l");
    expect(hostExecCalls[3]).toBe("tmux clear-history -t '%42'");
    expect(hostExecCalls[4]).toBe("tmux display-message -p -t '%42' '#{client_name}|#{client_tty}'");
    expect(hostExecCalls[9]).toContain("tmux new-window -P -F '#{window_id}' -d -n 'bring-homekeeper-oracle'");
    expect(hostExecCalls[9]).toContain("exec tmux attach-session -t");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(output()).toContain("opened as background tab (MAW_SAFE_SPLIT=1 — explicit smear-avoidance opt-in)");
    expect(output()).not.toContain("MAW_FORCE_SPLIT=1");
  });

  test("MAW_SAFE_SPLIT reuses an existing target window in the destination session", async () => {
    paneCommandResponse = "2.1.139";
    process.env.MAW_SAFE_SPLIT = "1";

    await maybeSplit("50-mawjs:mawjs-features", {
      split: true,
      splitTarget: "50-mawjs:mawjs-oracle",
    });

    expect(hostExecCalls.some(cmd => cmd.includes("tmux link-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux new-window"))).toBe(false);
    expect(output()).toContain("target tab already in this session — 50-mawjs:mawjs-features");
    expect(output()).toContain("target already in background tab");
  });

  test("MAW_SAFE_SPLIT links a cross-session target as a background tab when possible", async () => {
    paneCommandResponse = "2.1.139";
    process.env.MAW_SAFE_SPLIT = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", {
      split: true,
      splitTarget: "50-mawjs:mawjs-oracle",
    });

    expect(hostExecCalls.some(cmd => cmd.includes("tmux link-window -d -s '20-homekeeper:homekeeper-oracle' -t '50-mawjs:'"))).toBe(true);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux new-window"))).toBe(false);
    expect(output()).toContain("linked background tab — 20-homekeeper:homekeeper-oracle");
    expect(output()).toContain("linked as background tab");
  });

  test("#1909 — Claude-like bring to an existing window in the same session moves via join-pane", async () => {
    paneCommandResponse = "2.1.139";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("50-mawjs:mawjs-features", { split: true });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '%42' '#{pane_current_command}'");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("attach-session"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("link-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux join-pane -h -l 50% -s '50-mawjs:mawjs-features' -t '%42'"))).toBe(true);
    expect(output()).toContain("✓ joined beside — 50-mawjs:mawjs-features (same-session move; active pane)");
    expect(output()).not.toContain("same-session --split unsupported");
  });

  test("#1909 — #1827 Claude-like bring with explicit --to in the target session moves via join-pane", async () => {
    paneCommandResponse = "2.1.139";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("50-mawjs:mawjs-features", {
      split: true,
      splitTarget: "50-mawjs:mawjs-oracle",
    });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '50-mawjs:mawjs-oracle' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '50-mawjs:mawjs-oracle' '#{pane_current_command}'");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("attach-session"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("link-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux join-pane -h -l 50% -s '50-mawjs:mawjs-features' -t '50-mawjs:mawjs-oracle'"))).toBe(true);
    expect(output()).toContain("✓ joined beside — 50-mawjs:mawjs-features (same-session move; active pane)");
    expect(output()).not.toContain("same-session --split unsupported");
  });

  test("#1836 Claude-like bring splits cross-session targets by default", async () => {
    paneCommandResponse = "2.1.139";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '%42' '#{pane_current_command}'");
    expect(hostExecCalls[2]).toContain("tmux split-window -t '%42' -h -l 50%");
    expect(hostExecCalls[2]).toContain("TMUX= tmux attach-session -t");
    expect(hostExecCalls.some(cmd => cmd.includes("new-window"))).toBe(false);
    expect(output()).toContain("✓ split beside — 20-homekeeper:homekeeper-oracle (50%)");
    expect(output()).not.toContain("opened as background tab");
  });

  test("MAW_SAFE_SPLIT background-tab repaint falls back to current client refresh when source tty is unavailable", async () => {
    paneCommandResponse = "2.1.139";
    paneClientTtyResponse = "\n";
    process.env.MAW_SAFE_SPLIT = "1";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls[3]).toBe("tmux clear-history -t '%42'");
    expect(hostExecCalls[4]).toBe("tmux display-message -p -t '%42' '#{client_name}|#{client_tty}'");
    expect(hostExecCalls[5]).toBe("tmux refresh-client");
    expect(hostExecCalls[6]).toBe("tmux refresh-client -S");
    expect(output()).toContain("opened as background tab");
  });

  test("Claude-like caller panes split by default without MAW_FORCE_SPLIT (#1836)", async () => {
    paneCommandResponse = "2.1.139";

    await maybeSplit("20-homekeeper:homekeeper-oracle", { split: true });

    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window -t '%42' -h -l 50%"))).toBe(true);
    expect(output()).toContain("✓ split beside — 20-homekeeper:homekeeper-oracle (50%)");
    expect(output()).not.toContain("opened as background tab");
  });

  test("#1909 — same-session guard from Claude-like panes uses join-pane (no nested attach)", async () => {
    paneCommandResponse = "2.1.139";
    paneSessionWindowResponse = "50-mawjs:mawjs-oracle";

    await maybeSplit("50-mawjs:mawjs-features", { split: true });

    expect(hostExecCalls[0]).toBe("tmux display-message -p -t '%42' '#{session_name}:#{window_name}'");
    expect(hostExecCalls[1]).toBe("tmux display-message -p -t '%42' '#{pane_current_command}'");
    expect(hostExecCalls.some(cmd => cmd.includes("tmux split-window"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("attach-session"))).toBe(false);
    expect(hostExecCalls.some(cmd => cmd.includes("tmux join-pane"))).toBe(true);
    expect(output()).toContain("✓ joined beside — 50-mawjs:mawjs-features (same-session move; active pane)");
    expect(output()).not.toContain("same-session --split unsupported");
    expect(output()).not.toContain("nested attach would close the pane");
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
    expect(hostExecCalls.at(-1)).toContain("tmux new-window -P -F '#{window_id}' -d -n 'bring-homekeeper-oracle'");
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
