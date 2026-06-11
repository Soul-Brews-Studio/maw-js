import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

type ThrowValue = { readonly throwValue: unknown };
type HostExecResult = string | Error | ThrowValue;
type RunCall = { subcommand: string; args: Array<string | number> };
type RunResult = string | Error;

let hostExecCalls: Array<{ cmd: string; host?: string }> = [];
let hostExecScript: HostExecResult[] = [];

const throws = (throwValue: unknown): ThrowValue => ({ throwValue });
const isThrowValue = (value: HostExecResult): value is ThrowValue =>
  typeof value === "object" && value !== null && "throwValue" in value;

const hostExecMock = async (cmd: string, host?: string) => {
  hostExecCalls.push({ cmd, host });
  const next = hostExecScript.length > 0 ? hostExecScript.shift()! : "";
  if (next instanceof Error) throw next;
  if (isThrowValue(next)) throw next.throwValue;
  return next;
};

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "white.local",
  tmuxSocket: "/tmp/fourteenth pass.sock",
})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class");

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

const realSetTimeout = globalThis.setTimeout;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

describe("tmux-class fourteenth-pass isolated coverage", () => {
  beforeEach(() => {
    hostExecCalls = [];
    hostExecScript = [];
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("raw hostExec helpers quote numeric args and expose hard failures deterministically", async () => {
    hostExecScript = [
      "resized",
      new Error("capture failed"),
      throws("tmux primitive failure"),
      new Error("load failed"),
    ];
    const t = new Tmux("remote-box", "/tmp/fourteenth pass.sock");

    await expect(t.run("resize-pane", "-t", "alpha pane", "-x", 80, "-y", 24)).resolves.toBe("resized");
    await expect(t.capture("alpha pane", 8)).rejects.toThrow("capture failed");
    await expect(t.tryRun("display-message", "-p", "ignored")).resolves.toBe("");
    await expect(t.loadBuffer("alpha ' beta")).rejects.toThrow("load failed");

    expect(hostExecCalls).toEqual([
      {
        cmd: "tmux -S '/tmp/fourteenth pass.sock' resize-pane -t 'alpha pane' -x 80 -y 24",
        host: "remote-box",
      },
      {
        cmd: "tmux -S '/tmp/fourteenth pass.sock' capture-pane -t 'alpha pane' -e -p -S -8",
        host: "remote-box",
      },
      {
        cmd: "tmux -S '/tmp/fourteenth pass.sock' display-message -p ignored",
        host: "remote-box",
      },
      {
        cmd: String.raw`printf '%s' 'alpha '\'' beta' | tmux -S '/tmp/fourteenth pass.sock' load-buffer -`,
        host: "remote-box",
      },
    ]);
  });

  test("hard session creation failures do not run follow-up tuning or selection", async () => {
    const session = new RecordingTmux().queue("new-session", new Error("create failed"));
    await expect(session.newSession("alpha", { window: "main", cwd: "/repo" })).rejects.toThrow("create failed");
    expect(session.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-s", "alpha", "-n", "main", "-c", "/repo"] },
    ]);

    const grouped = new RecordingTmux().queue("new-session", new Error("group failed"));
    await expect(grouped.newGroupedSession("parent", "child", {
      cols: 120,
      rows: 44,
      window: "logs",
      windowSize: "smallest",
    })).rejects.toThrow("group failed");
    expect(grouped.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "parent", "-s", "child", "-x", 120, "-y", 44] },
    ]);
  });

  test("listSessions fails soft when a later window lookup races closed", async () => {
    const t = new RecordingTmux()
      .queue("list-sessions", "alpha\nbeta\n")
      .queue("list-windows", "0:main:1\n", new Error("beta window gone"));

    await expect(t.listSessions()).resolves.toEqual([]);

    expect(t.calls).toEqual([
      { subcommand: "list-sessions", args: ["-F", "#{session_name}"] },
      { subcommand: "list-windows", args: ["-t", "alpha", "-F", "#{window_index}:#{window_name}:#{window_active}"] },
      { subcommand: "list-windows", args: ["-t", "beta", "-F", "#{window_index}:#{window_name}:#{window_active}"] },
    ]);
  });

  test("sendText treats tab-separated ANSI-cleared prompts as pending until the final prompt clears", async () => {
    const t = new SubmitProbeTmux();
    t.captureScript = [
      "history line\n\x1b[Kagent$\tstill-pending\r",
      "agent$\t",
    ];

    await t.sendText("alpha:0.0", "still-pending");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:still-pending",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
