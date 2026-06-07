import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let currentConfig: { host?: string; tmuxSocket?: string } = {
  host: "white.local",
  tmuxSocket: "/tmp/fourth pass.sock",
};
let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecResult = "";
let hostExecError: Error | null = null;

const originalSocketEnv = process.env.MAW_TMUX_SOCKET;
delete process.env.MAW_TMUX_SOCKET;

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  if (hostExecError) throw hostExecError;
  return hostExecResult;
};

mock.module("../../src/config", () => mockConfigModule(() => currentConfig));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux, tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-fourth-pass");

const realSetTimeout = globalThis.setTimeout;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

type ThrowValue = { readonly throwValue: unknown };
type RunResult = string | Error | ThrowValue;
const throws = (throwValue: unknown): ThrowValue => ({ throwValue });
const isThrowValue = (value: RunResult): value is ThrowValue => typeof value === "object" && value !== null && "throwValue" in value;

class RunTmux extends Tmux {
  calls: Array<{ subcommand: string; args: Array<string | number> }> = [];
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
    if (isThrowValue(next)) throw next.throwValue;
    return next;
  }
}

class SubmitProbeTmux extends Tmux {
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
    this.calls.push(`sendKeysLiteral:${text.length}`);
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

describe("tmux-class fourth-pass isolated coverage", () => {
  beforeEach(() => {
    currentConfig = {
      host: "white.local",
      tmuxSocket: "/tmp/fourth pass.sock",
    };
    delete process.env.MAW_TMUX_SOCKET;
    hostExecCalls = [];
    hostExecResult = "";
    hostExecError = null;
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    if (originalSocketEnv === undefined) delete process.env.MAW_TMUX_SOCKET;
    else process.env.MAW_TMUX_SOCKET = originalSocketEnv;
  });

  test("default and no-socket raw commands cover both socket branches", async () => {
    hostExecResult = "ok";

    await expect(tmux.run("display-message", "-p", "ready now")).resolves.toBe("ok");

    currentConfig = { host: "white.local" };
    const noSocket = new Tmux("remote-box");
    await noSocket.run("display-message");
    await noSocket.capture("pane target", 4);
    await noSocket.loadBuffer("alpha 'beta' gamma");
    await expect(noSocket.tryRun("display-message", "-p", "safe arg")).resolves.toBe("ok");

    hostExecError = new Error("tmux unavailable");
    await expect(noSocket.tryRun("display-message", "-p", "ignored")).resolves.toBe("");

    expect(hostExecCalls).toEqual([
      {
        cmd: "TERM=xterm tmux -S '/tmp/fourth pass.sock' display-message -p 'ready now'",
        host: undefined,
      },
      {
        cmd: "TERM=xterm tmux display-message ",
        host: "remote-box",
      },
      {
        cmd: "tmux capture-pane -t 'pane target' -e -p 2>/dev/null | tail -4",
        host: "remote-box",
      },
      {
        cmd: String.raw`printf '%s' 'alpha '\''beta'\'' gamma' | tmux load-buffer -`,
        host: "remote-box",
      },
      {
        cmd: "TERM=xterm tmux display-message -p 'safe arg'",
        host: "remote-box",
      },
      {
        cmd: "TERM=xterm tmux display-message -p ignored",
        host: "remote-box",
      },
    ]);
  });

  test("session/window/pane wrappers omit optional arguments when unset", async () => {
    const t = new RunTmux();

    await t.newSession("bare");
    await t.newGroupedSession("parent", "child");
    await t.newWindow("bare", "scratch");
    await t.selectPane("bare:0.0");

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-s", "bare"] },
      { subcommand: "set-option", args: ["-t", "bare", "renumber-windows", "on"] },
      { subcommand: "new-session", args: ["-d", "-t", "parent", "-s", "child"] },
      { subcommand: "new-window", args: ["-t", "bare:", "-n", "scratch"] },
      { subcommand: "select-pane", args: ["-t", "bare:0.0"] },
    ]);
  });

  test("parsers handle child failures, empty fields, and zero-valued pane metadata", async () => {
    const failingWindows = new RunTmux()
      .queue("list-sessions", "alpha\n")
      .queue("list-windows", new Error("window list failed"));
    await expect(failingWindows.listSessions()).resolves.toEqual([]);

    const t = new RunTmux().queue(
      "list-panes",
      "%0|||shell|||alpha:zero.0|||zero title|||0|||/|||0\n",
      "\n",
      "alpha:0|||\nalpha:1|||node\nskip:0|||zsh\n",
      "\n",
    );

    await expect(t.listPanes()).resolves.toEqual([
      {
        id: "%0",
        command: "shell",
        target: "alpha:zero.0",
        title: "zero title",
        pid: 0,
        cwd: "/",
        lastActivity: 0,
      },
    ]);
    await expect(t.getPaneCommand("alpha:empty.0")).resolves.toBe("");
    await expect(t.getPaneCommands(["alpha:0", "alpha:1"])).resolves.toEqual({
      "alpha:0": "",
      "alpha:1": "node",
    });
    await expect(t.getPaneInfo("alpha:empty.0")).resolves.toEqual({ command: "", cwd: "" });
  });

  test("exitModeIfNeeded treats primitive not-in-mode races as benign", async () => {
    const t = new RunTmux()
      .queue("display-message", "1")
      .queue("send-keys", throws("pane is not in a mode anymore"));

    await expect(t.exitModeIfNeeded("alpha:0.0")).resolves.toBe(false);
    expect(t.calls).toEqual([
      { subcommand: "display-message", args: ["-t", "alpha:0.0", "-p", "#{pane_in_mode}"] },
      { subcommand: "send-keys", args: ["-t", "alpha:0.0", "-X", "cancel"] },
    ]);
  });

  test("sendText keeps exact-boundary payloads literal and treats blank captures as submitted", async () => {
    const t = new SubmitProbeTmux();
    const boundaryText = "x".repeat(500);
    t.captureScript = ["\n   \r\n"];

    await t.sendText("alpha:0.0", boundaryText);

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:500",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });

  test("sendText recognizes alternate prompt markers while retrying pending input", async () => {
    const t = new SubmitProbeTmux();
    t.captureScript = ["root# apt update", "root# "];

    await t.sendText("alpha:0.0", "apt update");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:10",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
