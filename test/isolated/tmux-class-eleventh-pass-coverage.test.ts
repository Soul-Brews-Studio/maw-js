import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecResult = "";

const originalSocketEnv = process.env.MAW_TMUX_SOCKET;

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  return hostExecResult;
};

mock.module("../../src/config", () => mockConfigModule(() => ({})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-eleventh-pass");

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

describe("tmux-class eleventh-pass isolated coverage", () => {
  beforeEach(() => {
    delete process.env.MAW_TMUX_SOCKET;
    hostExecCalls = [];
    hostExecResult = "";
  });

  afterEach(() => {
    if (originalSocketEnv === undefined) {
      delete process.env.MAW_TMUX_SOCKET;
    } else {
      process.env.MAW_TMUX_SOCKET = originalSocketEnv;
    }
  });

  test("default constructor uses the no-socket command path for raw tmux helpers", async () => {
    const t = new Tmux("remote-box");

    await t.run("display-message", "hello world");
    await t.capture("session:win.0", 7);
    await t.loadBuffer("don't quote twice");

    expect(hostExecCalls).toEqual([
      { cmd: "TERM=xterm tmux display-message 'hello world'", host: "remote-box" },
      { cmd: "tmux capture-pane -t session:win.0 -e -p 2>/dev/null | tail -7", host: "remote-box" },
      { cmd: "printf '%s' 'don'\\''t quote twice' | tmux load-buffer -", host: "remote-box" },
    ]);
  });


  test("environment socket is resolved by the default constructor before config fallback", async () => {
    process.env.MAW_TMUX_SOCKET = "/tmp/env socket.sock";
    const t = new Tmux("remote-box");

    await t.run("display-message", "#{session_name}");

    expect(hostExecCalls).toEqual([
      { cmd: "TERM=xterm tmux -S '/tmp/env socket.sock' display-message '#{session_name}'", host: "remote-box" },
    ]);
  });

  test("large capture delegates through run with a negative start line", async () => {
    const t = new RecordingTmux().queue("capture-pane", "captured");

    await expect(t.capture("alpha:logs.0", 200)).resolves.toBe("captured");

    expect(t.calls).toEqual([
      { subcommand: "capture-pane", args: ["-t", "alpha:logs.0", "-e", "-p", "-S", -200] },
    ]);
  });


  test("exitModeIfNeeded returns false without cancelling when pane is not in a mode", async () => {
    const t = new RecordingTmux().queue("display-message", "0\n");

    await expect(t.exitModeIfNeeded("alpha:normal.0")).resolves.toBe(false);

    expect(t.calls).toEqual([
      { subcommand: "display-message", args: ["-t", "alpha:normal.0", "-p", "#{pane_in_mode}"] },
    ]);
  });

  test("exitModeIfNeeded rethrows non-benign cancel failures", async () => {
    const t = new RecordingTmux()
      .queue("display-message", "1")
      .queue("send-keys", new Error("permission denied"));

    await expect(t.exitModeIfNeeded("alpha:copy.0")).rejects.toThrow("permission denied");

    expect(t.calls).toEqual([
      { subcommand: "display-message", args: ["-t", "alpha:copy.0", "-p", "#{pane_in_mode}"] },
      { subcommand: "send-keys", args: ["-t", "alpha:copy.0", "-X", "cancel"] },
    ]);
  });
});
