import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecResult = "";
let hostExecError: unknown = null;

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  if (hostExecError) throw hostExecError;
  return hostExecResult;
};

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "white.local",
  tmuxSocket: "/tmp/seventh-pass.sock",
})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-seventh-pass");

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

  constructor(private readonly exitModeResult = false) {
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

  async loadBuffer(text: string): Promise<void> {
    this.calls.push(`loadBuffer:${text.replace(/\n/g, "\\n")}`);
  }

  async pasteBuffer(_target: string): Promise<void> {
    this.calls.push("pasteBuffer");
  }

  async exitModeIfNeeded(target: string): Promise<boolean> {
    this.calls.push(`exitModeIfNeeded:${target}`);
    return this.exitModeResult;
  }
}

const realSetTimeout = globalThis.setTimeout;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

describe("tmux-class seventh-pass isolated coverage", () => {
  beforeEach(() => {
    hostExecCalls = [];
    hostExecResult = "";
    hostExecError = null;
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("explicit empty socket disables configured socket for raw hostExec paths", async () => {
    const t = new Tmux("remote-box", "");
    hostExecResult = "plain";

    await expect(t.run("display-message", "-p", "#{session_name}")).resolves.toBe("plain");
    await expect(t.capture("alpha pane", 3)).resolves.toBe("plain");
    await expect(t.loadBuffer("plain socketless text")).resolves.toBeUndefined();

    expect(hostExecCalls).toEqual([
      {
        cmd: "tmux display-message -p '#{session_name}'",
        host: "remote-box",
      },
      {
        cmd: "tmux capture-pane -t 'alpha pane' -e -p -S -3",
        host: "remote-box",
      },
      {
        cmd: "printf '%s' 'plain socketless text' | tmux load-buffer -",
        host: "remote-box",
      },
    ]);
  });

  test("listAll keeps sparse window records grouped by session in tmux output order", async () => {
    const t = new RecordingTmux().queue(
      "list-windows",
      "beta|||2|||logs|||0||\nalpha|||0|||main|||1|||/repo\nbeta|||3|||scratch|||1|||/tmp\n",
    );

    await expect(t.listAll()).resolves.toEqual([
      {
        name: "beta",
        windows: [
          { index: 2, name: "logs", active: false, cwd: undefined },
          { index: 3, name: "scratch", active: true, cwd: "/tmp" },
        ],
      },
      {
        name: "alpha",
        windows: [{ index: 0, name: "main", active: true, cwd: "/repo" }],
      },
    ]);
    expect(t.calls).toEqual([
      {
        subcommand: "list-windows",
        args: ["-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}"],
      },
    ]);
  });

  test("getPaneInfos returns successful pane info even when neighboring lookups fail", async () => {
    const t = new RecordingTmux().queue(
      "list-panes",
      "node\t/repo/app\nignored\t/path\n",
      new Error("pane closed"),
      "zsh\t\n",
    );

    await expect(t.getPaneInfos(["alpha:0.0", "alpha:0.1", "alpha:0.2"])).resolves.toEqual({
      "alpha:0.0": { command: "node", cwd: "/repo/app" },
      "alpha:0.2": { command: "zsh", cwd: "" },
    });
    expect(t.calls).toEqual([
      { subcommand: "list-panes", args: ["-t", "alpha:0.0", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
      { subcommand: "list-panes", args: ["-t", "alpha:0.1", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
      { subcommand: "list-panes", args: ["-t", "alpha:0.2", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
    ]);
  });

  test("sendText uses the buffer path for multiline text after leaving mode and retries chevron prompts", async () => {
    const t = new SubmitProbeTmux(true);
    t.captureScript = ["maw» run followup", "maw> run followup", "maw> "];

    await t.sendText("alpha:0.0", "run\nfollowup");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "loadBuffer:run\\nfollowup",
      "pasteBuffer",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
