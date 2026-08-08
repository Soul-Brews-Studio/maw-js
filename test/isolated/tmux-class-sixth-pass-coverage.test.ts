import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecResult = "";

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  return hostExecResult;
};

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "white.local",
  tmuxSocket: "/tmp/configured-sixth-pass.sock",
})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-sixth-pass");

type RunCall = { subcommand: string; args: Array<string | number> };
type RunResult = string | Error;

class RecordingTmux extends Tmux {
  calls: RunCall[] = [];
  private script = new Map<string, RunResult[]>();

  constructor() {
    super(undefined, "");
  }

  queue(subcommand: string, ...results: RunResult[]) {
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

class SubmitProbeTmux extends Tmux {
  calls: string[] = [];
  captureScript: string[] = [];
  private captureIdx = 0;

  constructor() {
    super(undefined, "");
  }

  async capture(_target: string, lines = 80): Promise<string> {
    this.calls.push(`capture:${lines}`);
    const next = this.captureScript[this.captureIdx] ?? this.captureScript.at(-1) ?? "";
    this.captureIdx++;
    return next;
  }

  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }

  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }

  async exitModeIfNeeded(target: string): Promise<boolean> {
    this.calls.push(`exitModeIfNeeded:${target}`);
    return false;
  }
}

class ExitModeFailureTmux extends Tmux {
  calls: string[] = [];

  constructor() {
    super(undefined, "");
  }

  async exitModeIfNeeded(target: string): Promise<boolean> {
    this.calls.push(`exitModeIfNeeded:${target}`);
    throw new Error("copy-mode probe failed hard");
  }

  async sendKeysLiteral(_target: string, text: string): Promise<void> {
    this.calls.push(`sendKeysLiteral:${text}`);
  }

  async sendKeys(_target: string, ...keys: string[]): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
  }
}

const realSetTimeout = globalThis.setTimeout;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

describe("tmux-class sixth-pass isolated coverage", () => {
  beforeEach(() => {
    hostExecCalls = [];
    hostExecResult = "";
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("explicit constructor socket overrides configured socket for raw tmux commands", async () => {
    const t = new Tmux("remote-box", "/tmp/explicit socket.sock");
    hostExecResult = "ok";

    await expect(t.run("display-message")).resolves.toBe("ok");
    await t.capture("pane target", 50);
    await t.loadBuffer("quote ' storm");

    expect(hostExecCalls).toEqual([
      {
        cmd: "tmux -S '/tmp/explicit socket.sock' display-message ",
        host: "remote-box",
      },
      {
        cmd: "tmux -S '/tmp/explicit socket.sock' capture-pane -t 'pane target' -e -p -S -50",
        host: "remote-box",
      },
      {
        cmd: String.raw`printf '%s' 'quote '\'' storm' | tmux -S '/tmp/explicit socket.sock' load-buffer -`,
        host: "remote-box",
      },
    ]);
  });

  test("rows-only grouped sessions and remaining best-effort wrappers keep failures soft", async () => {
    const t = new RecordingTmux()
      .queue("set-option", new Error("option failed"))
      .queue("switch-client", new Error("not inside tmux"))
      .queue("kill-window", new Error("window already gone"))
      .queue("resize-pane", new Error("pane already gone"))
      .queue("resize-window", new Error("window already gone"))
      .queue("set", new Error("set failed"));

    await expect(t.newGroupedSession("parent", "child", {
      rows: 33,
      windowSize: "latest",
    })).resolves.toBeUndefined();
    await expect(t.switchClient("child")).resolves.toBeUndefined();
    await expect(t.killWindow("child:old")).resolves.toBeUndefined();
    await expect(t.resizePane("child:0.0", 90, 40)).resolves.toBeUndefined();
    await expect(t.resizeWindow("child:0", 90, 40)).resolves.toBeUndefined();
    await expect(t.set("child", "remain-on-exit", "on")).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "parent", "-s", "child", "-y", 33] },
      { subcommand: "set-option", args: ["-t", "child", "window-size", "latest"] },
      { subcommand: "switch-client", args: ["-t", "child"] },
      { subcommand: "kill-window", args: ["-t", "child:old"] },
      { subcommand: "resize-pane", args: ["-t", "child:0.0", "-x", 90, "-y", 40] },
      { subcommand: "resize-window", args: ["-t", "child:0", "-x", 90, "-y", 40] },
      { subcommand: "set", args: ["-t", "child", "remain-on-exit", "on"] },
    ]);
  });

  test("pane parsers preserve partial records and command-only info without fabricating fields", async () => {
    const t = new RecordingTmux().queue(
      "list-panes",
      "%9|||node|||alpha:main.0|||partial title\n",
      "alpha:2\nalpha:3|||bun\n",
      "python\n",
    );

    await expect(t.listPanes()).resolves.toEqual([
      {
        id: "%9",
        command: "node",
        target: "alpha:main.0",
        title: "partial title",
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
    await expect(t.getPaneCommands(["alpha:2", "alpha:3"])).resolves.toEqual({
      "alpha:2": "",
      "alpha:3": "bun",
    });
    await expect(t.getPaneInfo("alpha:0.0")).resolves.toEqual({
      command: "python",
      cwd: "",
    });
  });

  test("sendText retries percent prompts with pending input but ignores markers without whitespace", async () => {
    const pending = new SubmitProbeTmux();
    pending.captureScript = ["agent% make test", "agent% "];

    await pending.sendText("alpha:0.0", "make test");

    expect(pending.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:make test",
      "sendKeys:Enter",
      "capture:8",
      "sendKeys:Enter",
      "capture:8",
    ]);

    const noWhitespace = new SubmitProbeTmux();
    noWhitespace.captureScript = ["agent%unrelated text"];

    await noWhitespace.sendText("alpha:0.0", "make test");

    expect(noWhitespace.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:make test",
      "sendKeys:Enter",
      "capture:8",
    ]);
  });

  test("sendText propagates exit-mode failures before mutating pane input", async () => {
    const t = new ExitModeFailureTmux();

    await expect(t.sendText("alpha:0.0", "do not send")).rejects.toThrow("copy-mode probe failed hard");

    expect(t.calls).toEqual(["exitModeIfNeeded:alpha:0.0"]);
  });
});
