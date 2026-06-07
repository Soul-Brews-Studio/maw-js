import { describe, expect, test } from "bun:test";
import { Tmux } from "../src/core/transport/tmux-class";

type RunCall = { subcommand: string; args: (string | number)[] };
type RunHandler = (subcommand: string, args: (string | number)[], callIndex: number) => string | Promise<string>;

class FakeTmux extends Tmux {
  calls: RunCall[] = [];
  handler: RunHandler;

  constructor(handler: RunHandler = () => "") {
    super(undefined, "");
    this.handler = handler;
  }

  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    const callIndex = this.calls.length;
    this.calls.push({ subcommand, args });
    return this.handler(subcommand, args, callIndex);
  }

  callStrings(): string[] {
    return this.calls.map(c => [c.subcommand, ...c.args].join(" "));
  }
}

class FakeSubmitTmux extends Tmux {
  calls: string[] = [];
  captureScript: string[] = [];
  private captureIndex = 0;

  constructor() {
    super(undefined, "");
  }

  async exitModeIfNeeded(target: string): Promise<boolean> {
    this.calls.push(`exitModeIfNeeded:${target}`);
    return true;
  }

  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }

  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }

  async capture(_target: string, lines = 80): Promise<string> {
    this.calls.push(`capture:${lines}`);
    const next = this.captureScript[this.captureIndex] ?? this.captureScript.at(-1) ?? "";
    this.captureIndex++;
    return next;
  }
}

function byCommand(outputs: Record<string, string | Error>): RunHandler {
  return (subcommand, args) => {
    const key = [subcommand, ...args].join(" ");
    const value = outputs[key] ?? outputs[subcommand] ?? "";
    if (value instanceof Error) throw value;
    return value;
  };
}

describe("Tmux command wrapper coverage", () => {
  test("listSessions loads windows per session and fails soft when tmux is absent", async () => {
    const t = new FakeTmux(byCommand({
      "list-sessions -F #{session_name}": "alpha\nbeta\n",
      "list-windows -t alpha -F #{window_index}:#{window_name}:#{window_active}": "0:main:1\n1:work:0",
      "list-windows -t beta -F #{window_index}:#{window_name}:#{window_active}": "2:solo:1",
    }));

    expect(await t.listSessions()).toEqual([
      { name: "alpha", windows: [{ index: 0, name: "main", active: true }, { index: 1, name: "work", active: false }] },
      { name: "beta", windows: [{ index: 2, name: "solo", active: true }] },
    ]);
    expect(t.callStrings()[0]).toBe("list-sessions -F #{session_name}");

    const missing = new FakeTmux(() => { throw new Error("no server"); });
    expect(await missing.listSessions()).toEqual([]);

    const missingBinary = Object.assign(new Error("bash: tmux: command not found"), { exitCode: 127 });
    const pm2PathFailure = new FakeTmux(() => { throw missingBinary; });
    await expect(pm2PathFailure.listSessions()).rejects.toThrow("tmux: command not found");
  });

  test("listAll groups windows and returns empty on tmux failure", async () => {
    const t = new FakeTmux(() => [
      "alpha|||0|||main|||1|||/repo/a",
      "alpha|||1|||work|||0|||",
      "beta|||3|||solo|||1|||/repo/b",
    ].join("\n"));

    expect(await t.listAll()).toEqual([
      { name: "alpha", windows: [{ index: 0, name: "main", active: true, cwd: "/repo/a" }, { index: 1, name: "work", active: false, cwd: undefined }] },
      { name: "beta", windows: [{ index: 3, name: "solo", active: true, cwd: "/repo/b" }] },
    ]);

    const failing = new FakeTmux(() => { throw new Error("tmux down"); });
    expect(await failing.listAll()).toEqual([]);
  });

  test("session and window mutators build the expected tmux subcommands", async () => {
    const t = new FakeTmux();

    expect(await t.hasSession("oracle")).toBe(true);
    await t.newSession("oracle", { window: "main", cwd: "/repo", detached: false });
    await t.newGroupedSession("oracle", "maw-pty-1", { cols: 120, rows: 40, windowSize: "manual", window: "work" });
    await t.newWindow("oracle", "child", { cwd: "/repo/child" });
    await t.selectWindow("oracle:child");
    await t.switchClient("oracle");
    await t.switchClient("oracle-view", { readonly: true });
    await t.killWindow("oracle:child");
    await t.linkWindow("oracle:main", "maw-view:1");
    await t.unlinkWindow("maw-view:linked");
    await t.renameWindow("maw-view:1", "linked");
    await t.setWindowOption("maw-view:1", "@maw-linked-from", "oracle:main");
    await t.killSession("maw-pty-1");

    expect(t.callStrings()).toEqual([
      "has-session -t oracle",
      "new-session -s oracle -n main -c /repo",
      "set-option -t oracle renumber-windows on",
      "new-session -d -t oracle -s maw-pty-1 -x 120 -y 40",
      "set-option -t maw-pty-1 window-size manual",
      "select-window -t maw-pty-1:work",
      "new-window -t oracle: -n child -c /repo/child",
      "select-window -t oracle:child",
      "switch-client -t oracle",
      "display-message -p #{client_readonly}",
      "switch-client -r -t oracle-view",
      "kill-window -t oracle:child",
      "link-window -d -s oracle:main -t maw-view:1",
      "unlink-window -t maw-view:linked",
      "rename-window -t maw-view:1 linked",
      "set-window-option -t maw-view:1 @maw-linked-from oracle:main",
      "kill-session -t maw-pty-1",
    ]);
  });

  test("hasSession and tryRun convert tmux errors to falsey results", async () => {
    const t = new FakeTmux(() => { throw new Error("can't find session"); });

    expect(await t.hasSession("missing")).toBe(false);
    expect(await t.tryRun("kill-window", "-t", "missing:0")).toBe("");
  });

  test("read-only switch preserves an already read-only client instead of toggling it off", async () => {
    const t = new FakeTmux(byCommand({
      "display-message -p #{client_readonly}": "1\n",
    }));

    await t.switchClient("oracle-view", { readonly: true });

    expect(t.callStrings()).toEqual([
      "display-message -p #{client_readonly}",
      "switch-client -t oracle-view",
    ]);
  });

  test("pane list/info helpers parse optional fields and tolerate failures", async () => {
    const t = new FakeTmux(byCommand({
      "list-panes -a -F #{pane_id}": "%1\n%2\n",
      "list-panes -a -F #{pane_id}|||#{pane_current_command}|||#{session_name}:#{window_name}.#{pane_index}|||#{pane_title}|||#{pane_pid}|||#{pane_current_path}|||#{window_activity}": [
        "%1|||claude|||s:main.0|||oracle|||123|||/repo|||1715840000",
        "%2|||zsh|||s:shell.1||||||",
      ].join("\n"),
      "list-panes -t s:main.0 -F #{pane_current_command}": "claude\n",
      "list-panes -a -F #{session_name}:#{window_index}|||#{pane_current_command}": "s:0|||claude\ns:1|||zsh\n",
      "list-panes -t s:main.0 -F #{pane_current_command}\t#{pane_current_path}": "claude\t/repo\n",
      "list-panes -t s:shell.1 -F #{pane_current_command}\t#{pane_current_path}": "zsh\t/tmp\n",
    }));

    expect(await t.listPaneIds()).toEqual(new Set(["%1", "%2"]));
    expect(await t.listPanes()).toEqual([
      { id: "%1", command: "claude", target: "s:main.0", title: "oracle", pid: 123, cwd: "/repo", lastActivity: 1715840000 },
      { id: "%2", command: "zsh", target: "s:shell.1", title: "", pid: undefined, cwd: undefined, lastActivity: undefined },
    ]);
    expect(await t.getPaneCommand("s:main.0")).toBe("claude");
    expect(await t.getPaneCommands(["s:0", "s:missing"])).toEqual({ "s:0": "claude" });
    expect(await t.getPaneInfo("s:main.0")).toEqual({ command: "claude", cwd: "/repo" });
    expect(await t.getPaneInfos(["s:main.0", "s:shell.1"])).toEqual({
      "s:main.0": { command: "claude", cwd: "/repo" },
      "s:shell.1": { command: "zsh", cwd: "/tmp" },
    });

    const failing = new FakeTmux(() => { throw new Error("tmux down"); });
    expect(await failing.listPaneIds()).toEqual(new Set());
    expect(await failing.listPanes()).toEqual([]);
    expect(await failing.getPaneCommands(["s:0"])).toEqual({});
    expect(await failing.getPaneInfos(["s:0"])).toEqual({});
  });

  test("pane and option mutators clamp dimensions and preserve target arguments", async () => {
    const t = new FakeTmux();

    await t.killPane("s:0.1");
    await t.resizePane("s:0.1", 9999, -5);
    await t.resizeWindow("s:0", 80.8, 24.2);
    await t.splitWindow("s:0");
    await t.selectPane("s:0.1", { title: "work pane" });
    await t.selectLayout("s:0", "tiled");
    await t.attachReadonly("s");
    await t.pipePane("s:0.1", "cat > /tmp/out", { onlyIfClosed: true });
    await t.pipePane("s:0.1", undefined, { input: true, output: false });
    await t.synchronizePanes("s:0", true);
    await t.sendKeys("s:0.1", "C-c", "Enter");
    await t.sendKeysLiteral("s:0.1", "hello world");
    await t.pasteBuffer("s:0.1");
    await t.setEnvironment("s", "MAW_TEST", "1");
    await t.setOption("s", "status", "off");
    await t.set("s", "status-style", "bg=colour235,fg=colour248");

    expect(t.callStrings()).toEqual([
      "kill-pane -t s:0.1",
      "resize-pane -t s:0.1 -x 500 -y 1",
      "resize-window -t s:0 -x 80 -y 24",
      "split-window -t s:0",
      "select-pane -t s:0.1 -T work pane",
      "select-layout -t s:0 tiled",
      "attach-session -r -t s",
      "pipe-pane -O -o -t s:0.1 cat > /tmp/out",
      "pipe-pane -I -t s:0.1",
      "set-window-option -t s:0 synchronize-panes on",
      "send-keys -t s:0.1 C-c Enter",
      "send-keys -t s:0.1 -l hello world",
      "paste-buffer -t s:0.1",
      "set-environment -t s MAW_TEST 1",
      "set-option -t s status off",
      "set -t s status-style bg=colour235,fg=colour248",
    ]);
  });

  test("capture delegates long scrollback requests through the tmux arg builder", async () => {
    const t = new FakeTmux(byCommand({
      "capture-pane -t s:logs.0 -e -p -S -120": "older output",
    }));

    expect(await t.capture("s:logs.0", 120)).toBe("older output");
    expect(t.callStrings()).toEqual([
      "capture-pane -t s:logs.0 -e -p -S -120",
    ]);
  });

  test("sendText exits transient tmux mode, sends literal text, and stops after confirmed submit", async () => {
    const t = new FakeSubmitTmux();
    t.captureScript = [
      "history\nagent$ pending",
      "agent$ ",
    ];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
      if (typeof fn === "function") fn(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      await t.sendText("s:main.0", "pending");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(t.calls).toEqual([
      "exitModeIfNeeded:s:main.0",
      "sendKeysLiteral:pending",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });

  test("exitModeIfNeeded cancels copy-mode only when necessary and treats benign races as no-op", async () => {
    const normal = new FakeTmux(() => "0");
    expect(await normal.exitModeIfNeeded("s:0")).toBe(false);
    expect(normal.callStrings()).toEqual(["display-message -t s:0 -p #{pane_in_mode}"]);

    const copy = new FakeTmux((subcommand, _args, index) => {
      if (index === 0) return "1";
      expect(subcommand).toBe("send-keys");
      return "";
    });
    expect(await copy.exitModeIfNeeded("s:0")).toBe(true);
    expect(copy.callStrings()).toEqual([
      "display-message -t s:0 -p #{pane_in_mode}",
      "send-keys -t s:0 -X cancel",
    ]);

    const probeFails = new FakeTmux(() => { throw new Error("can't find pane"); });
    expect(await probeFails.exitModeIfNeeded("s:0")).toBe(false);

    const race = new FakeTmux((_subcommand, _args, index) => {
      if (index === 0) return "1";
      throw new Error("not in a mode");
    });
    expect(await race.exitModeIfNeeded("s:0")).toBe(false);

    const hardFailure = new FakeTmux((_subcommand, _args, index) => {
      if (index === 0) return "1";
      throw new Error("permission denied");
    });
    await expect(hardFailure.exitModeIfNeeded("s:0")).rejects.toThrow("permission denied");
  });
});
