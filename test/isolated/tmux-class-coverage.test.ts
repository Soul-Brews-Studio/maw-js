import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecResult = "";
let hostExecError: Error | null = null;

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  if (hostExecError) throw hostExecError;
  return hostExecResult;
};

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "white.local",
  tmuxSocket: "/tmp/maw socket.sock",
})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-coverage");

const realSetTimeout = globalThis.setTimeout;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

class ScriptedTmux extends Tmux {
  calls: string[] = [];
  captureScript: Array<string | Error> = [];
  private captureIdx = 0;

  constructor() {
    super(undefined, "");
  }

  async capture(_target: string, lines = 80): Promise<string> {
    this.calls.push(`capture:${lines}`);
    const next = this.captureScript[this.captureIdx] ?? this.captureScript.at(-1) ?? "";
    this.captureIdx++;
    if (next instanceof Error) throw next;
    return next;
  }

  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }

  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }

  async loadBuffer(text: string): Promise<void> {
    this.calls.push(`loadBuffer:${text.length}`);
  }

  async pasteBuffer(_target: string): Promise<void> {
    this.calls.push("pasteBuffer");
  }

  async exitModeIfNeeded(target: string): Promise<boolean> {
    this.calls.push(`exitModeIfNeeded:${target}`);
    return false;
  }
}

class RunTmux extends Tmux {
  calls: Array<{ subcommand: string; args: Array<string | number> }> = [];
  private script = new Map<string, Array<string | Error>>();

  constructor() {
    super(undefined, "");
  }

  queue(subcommand: string, ...results: Array<string | Error>) {
    const existing = this.script.get(subcommand) ?? [];
    existing.push(...results);
    this.script.set(subcommand, existing);
    return this;
  }

  async run(subcommand: string, ...args: Array<string | number>): Promise<string> {
    this.calls.push({ subcommand, args });
    const queue = this.script.get(subcommand) ?? [];
    const next = queue.length > 0 ? queue.shift()! : "";
    this.script.set(subcommand, queue);
    if (next instanceof Error) throw next;
    return next;
  }
}

class InfoTmux extends Tmux {
  constructor(private readonly infoByTarget: Record<string, { command: string; cwd: string } | Error>) {
    super(undefined, "");
  }

  override async getPaneInfo(target: string): Promise<{ command: string; cwd: string }> {
    const entry = this.infoByTarget[target];
    if (entry instanceof Error) throw entry;
    return entry ?? { command: "", cwd: "" };
  }
}

describe("tmux-class isolated coverage", () => {
  beforeEach(() => {
    hostExecCalls = [];
    hostExecResult = "";
    hostExecError = null;
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("run/loadBuffer/capture use quoted socket commands and preserve host", async () => {
    const t = new Tmux("remote-box");

    await t.run("list-panes", "-t", "sess:oracle.0", "-F", "#{pane_id}");
    await t.capture("sess:oracle.0", 12);
    await t.loadBuffer("it's ready");

    expect(hostExecCalls).toEqual([
      {
        cmd: "tmux -S '/tmp/maw socket.sock' list-panes -t sess:oracle.0 -F '#{pane_id}'",
        host: "remote-box",
      },
      {
        cmd: "tmux -S '/tmp/maw socket.sock' capture-pane -t sess:oracle.0 -e -p -S -12",
        host: "remote-box",
      },
      {
        cmd: "printf '%s' 'it'\\''s ready' | tmux -S '/tmp/maw socket.sock' load-buffer -",
        host: "remote-box",
      },
    ]);
  });

  test("sendText retries from ANSI-colored pending input and stops once the prompt clears", async () => {
    const t = new ScriptedTmux();
    t.captureScript = [
      "\x1b[32m❯\x1b[0m deploy now\r",
      "\x1b[32m❯\x1b[0m \r",
    ];

    await t.sendText("sess:oracle.0", "deploy now");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:sess:oracle.0",
      "sendKeysLiteral:deploy now",
      "sendKeys:Enter",
      "capture:8",
      "sendKeys:Enter",
      "capture:8",
    ]);
  });

  test("sendText uses the buffer path for long single-line payloads", async () => {
    const t = new ScriptedTmux();
    const longText = "x".repeat(501);
    t.captureScript = ["$ \r"];

    await t.sendText("sess:oracle.0", longText);

    expect(t.calls).toEqual([
      "exitModeIfNeeded:sess:oracle.0",
      `loadBuffer:${longText.length}`,
      "pasteBuffer",
      "sendKeys:Enter",
      "capture:8",
    ]);
  });

  test("session and pane parsers handle tmux output plus missing-server fallbacks", async () => {
    const t = new RunTmux()
      .queue("list-sessions", "home\nwork\n", new Error("no server"))
      .queue(
        "list-windows",
        "0:main:1\n1:notes:0\n",
        "0:jobs:1\n",
        "home|||0|||main|||1|||/tmp/home\nhome|||1|||notes|||0||\nwork|||0|||jobs|||1|||/srv/work\n",
        new Error("no server"),
      )
      .queue("has-session", "", new Error("missing"))
      .queue("list-panes", "%1\n%2\n", new Error("no panes"));

    await expect(t.listSessions()).resolves.toEqual([
      {
        name: "home",
        windows: [
          { index: 0, name: "main", active: true },
          { index: 1, name: "notes", active: false },
        ],
      },
      {
        name: "work",
        windows: [{ index: 0, name: "jobs", active: true }],
      },
    ]);

    await expect(t.listSessions()).resolves.toEqual([]);
    await expect(t.listAll()).resolves.toEqual([
      {
        name: "home",
        windows: [
          { index: 0, name: "main", active: true, cwd: "/tmp/home" },
          { index: 1, name: "notes", active: false, cwd: undefined },
        ],
      },
      {
        name: "work",
        windows: [{ index: 0, name: "jobs", active: true, cwd: "/srv/work" }],
      },
    ]);
    await expect(t.listAll()).resolves.toEqual([]);
    expect(await t.hasSession("home")).toBe(true);
    expect(await t.hasSession("missing")).toBe(false);
    await expect(t.listPaneIds()).resolves.toEqual(new Set(["%1", "%2"]));
    await expect(t.listPaneIds()).resolves.toEqual(new Set());
  });

  test("wrapper commands format tmux operations and clamp resize limits", async () => {
    const t = new RunTmux()
      .queue("list-windows", "2:chat:1\n")
      .queue("list-panes", "zsh\n", "home:0|||zsh\nhome:1|||bun\n", "bun\t/tmp/repo\n");

    await t.newSession("fresh", { window: "oracle", cwd: "/repo", detached: false });
    await t.newGroupedSession("home", "child", {
      cols: 120,
      rows: 40,
      window: "notes",
      windowSize: "largest",
    });
    await expect(t.listWindows("home")).resolves.toEqual([{ index: 2, name: "chat", active: true }]);
    await t.newWindow("home", "scratch", { cwd: "/tmp" });
    await t.selectWindow("home:notes");
    await t.switchClient("home");
    await t.killWindow("home:notes");
    await t.killSession("child");
    await t.killPane("home:dead.0");
    await expect(t.getPaneCommand("home:0")).resolves.toBe("zsh");
    await expect(t.getPaneCommands(["home:0", "missing"])).resolves.toEqual({ "home:0": "zsh" });
    await expect(t.getPaneInfo("home:1")).resolves.toEqual({ command: "bun", cwd: "/tmp/repo" });
    await t.resizePane("home:0", 999.9, 0);
    await t.resizeWindow("home:1", -20, 999);
    await t.splitWindow("home:0");
    await t.selectPane("home:0", { title: "oracle" });
    await t.selectLayout("home", "tiled");
    await t.sendKeys("home:0", "C-c", "Enter");
    await t.sendKeysLiteral("home:0", "hello");
    await t.pasteBuffer("home:0");
    await t.setEnvironment("home", "MAW_ROLE", "oracle");
    await t.setOption("home", "status", "off");
    await t.set("home", "remain-on-exit", "on");
    await expect(t.capture("home:0", 51)).resolves.toBe("");

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-s", "fresh", "-n", "oracle", "-c", "/repo"] },
      { subcommand: "set-option", args: ["-t", "fresh", "renumber-windows", "on"] },
      { subcommand: "new-session", args: ["-d", "-t", "home", "-s", "child", "-x", 120, "-y", 40] },
      { subcommand: "set-option", args: ["-t", "child", "window-size", "largest"] },
      { subcommand: "select-window", args: ["-t", "child:notes"] },
      { subcommand: "list-windows", args: ["-t", "home", "-F", "#{window_index}:#{window_name}:#{window_active}"] },
      { subcommand: "new-window", args: ["-t", "home:", "-n", "scratch", "-c", "/tmp"] },
      { subcommand: "select-window", args: ["-t", "home:notes"] },
      { subcommand: "switch-client", args: ["-t", "home"] },
      { subcommand: "kill-window", args: ["-t", "home:notes"] },
      { subcommand: "kill-session", args: ["-t", "child"] },
      { subcommand: "kill-pane", args: ["-t", "home:dead.0"] },
      { subcommand: "list-panes", args: ["-t", "home:0", "-F", "#{pane_current_command}"] },
      { subcommand: "list-panes", args: ["-a", "-F", "#{session_name}:#{window_index}|||#{pane_current_command}"] },
      { subcommand: "list-panes", args: ["-t", "home:1", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
      { subcommand: "resize-pane", args: ["-t", "home:0", "-x", 500, "-y", 1] },
      { subcommand: "resize-window", args: ["-t", "home:1", "-x", 1, "-y", 200] },
      { subcommand: "split-window", args: ["-t", "home:0"] },
      { subcommand: "select-pane", args: ["-t", "home:0", "-T", "oracle"] },
      { subcommand: "select-layout", args: ["-t", "home", "tiled"] },
      { subcommand: "send-keys", args: ["-t", "home:0", "C-c", "Enter"] },
      { subcommand: "send-keys", args: ["-t", "home:0", "-l", "hello"] },
      { subcommand: "paste-buffer", args: ["-t", "home:0"] },
      { subcommand: "set-environment", args: ["-t", "home", "MAW_ROLE", "oracle"] },
      { subcommand: "set-option", args: ["-t", "home", "status", "off"] },
      { subcommand: "set", args: ["-t", "home", "remain-on-exit", "on"] },
      { subcommand: "capture-pane", args: ["-t", "home:0", "-e", "-p", "-S", -51] },
    ]);
  });

  test("pane helpers tolerate closed panes and list-panes failures", async () => {
    const t = new RunTmux()
      .queue(
        "list-panes",
        "%1|||bun|||home:chat.0|||oracle|||123|||/tmp/repo|||456\n%2|||zsh|||home:chat.1|||shell||||||\n",
        new Error("gone"),
      );

    await expect(t.listPanes()).resolves.toEqual([
      {
        id: "%1",
        command: "bun",
        target: "home:chat.0",
        title: "oracle",
        pid: 123,
        cwd: "/tmp/repo",
        lastActivity: 456,
        top: undefined,
        left: undefined,
        w: undefined,
        h: undefined,
        paneIdx: undefined,
        winIdx: undefined,
        winName: undefined,
        active: false,
        window: { w: undefined, h: undefined, active: false },
        attached: false,
      },
      {
        id: "%2",
        command: "zsh",
        target: "home:chat.1",
        title: "shell",
        pid: undefined,
        cwd: undefined,
        lastActivity: undefined,
        top: undefined,
        left: undefined,
        w: undefined,
        h: undefined,
        paneIdx: undefined,
        winIdx: undefined,
        winName: undefined,
        active: false,
        window: { w: undefined, h: undefined, active: false },
        attached: false,
      },
    ]);
    await expect(t.listPanes()).resolves.toEqual([]);

    const info = new InfoTmux({
      "home:chat.0": { command: "bun", cwd: "/tmp/repo" },
      "home:chat.1": new Error("closed"),
    });
    await expect(info.getPaneInfos(["home:chat.0", "home:chat.1"])).resolves.toEqual({
      "home:chat.0": { command: "bun", cwd: "/tmp/repo" },
    });
  });

  test("best-effort wrappers swallow direct run failures in the shared tryRun path", async () => {
    const soft = new RunTmux()
      .queue("kill-session", new Error("session gone"))
      .queue("kill-pane", new Error("pane gone"))
      .queue("set-option", new Error("option gone"));

    await expect(soft.killSession("missing")).resolves.toBeUndefined();
    await expect(soft.killPane("missing:0.0")).resolves.toBeUndefined();
    await expect(soft.setOption("missing", "status", "off")).resolves.toBeUndefined();
  });

  test("exitModeIfNeeded handles active mode, benign races, and probe failures", async () => {
    const active = new RunTmux()
      .queue("display-message", "1")
      .queue("send-keys", "");
    expect(await active.exitModeIfNeeded("home:chat.0")).toBe(true);

    const race = new RunTmux()
      .queue("display-message", "1")
      .queue("send-keys", new Error("not in a mode"));
    expect(await race.exitModeIfNeeded("home:chat.0")).toBe(false);

    const probeFailure = new RunTmux()
      .queue("display-message", new Error("can't find pane"));
    expect(await probeFailure.exitModeIfNeeded("home:chat.0")).toBe(false);
  });

  test("sendText warns after repeated pending-input retries", async () => {
    const t = new ScriptedTmux();
    t.captureScript = Array.from({ length: 4 }, () => "\x1b[32m❯\x1b[0m deploy now\r");
    const realWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;

    try {
      await t.sendText("sess:oracle.0", "deploy now");
    } finally {
      console.warn = realWarn;
    }

    // Final attempt escalates the named Enter to a literal C-m (Enter-eaten
    // last-ditch): 3 Enter + 1 C-m. Two warns now — the C-m escalation and the
    // exhausted-retries warning.
    expect(t.calls.filter(call => call === "sendKeys:Enter")).toHaveLength(3);
    expect(t.calls.filter(call => call === "sendKeys:C-m")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[tmux] submitWithConfirm: sess:oracle.0 escalating to literal C-m on final attempt 4/4",
    );
    expect(warn).toHaveBeenCalledWith(
      "[tmux] sendText: sess:oracle.0 still shows pending input after 4 submit attempts — command may not have submitted",
    );
  });
});
