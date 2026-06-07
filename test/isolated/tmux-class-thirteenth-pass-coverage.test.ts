import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Tmux } from "../../src/core/transport/tmux-class";

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
    this.calls.push(`sendKeysLiteral:${text.length}:${text.slice(0, 12)}`);
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

const realSetTimeout = globalThis.setTimeout;
const realWarn = console.warn;
const immediateSetTimeout = ((fn: TimerHandler, _ms?: number, ...args: unknown[]) => {
  if (typeof fn === "function") fn(...args);
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

describe("tmux-class thirteenth-pass isolated coverage", () => {
  beforeEach(() => {
    globalThis.setTimeout = immediateSetTimeout;
    console.warn = mock(() => undefined) as typeof console.warn;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    console.warn = realWarn;
  });

  test("window and pane list parsers preserve active flags, cwd blanks, and unmatched commands", async () => {
    const t = new RecordingTmux()
      .queue("list-windows", "0:main:1\n2:logs:0\n")
      .queue("list-windows", "alpha|||0|||main|||1|||/repo\nalpha|||1|||empty|||0|||\nbeta|||3|||ops|||1|||/srv\n")
      .queue("list-panes", "alpha:0|||bash\nalpha:2|||\n");

    await expect(t.listWindows("alpha")).resolves.toEqual([
      { index: 0, name: "main", active: true },
      { index: 2, name: "logs", active: false },
    ]);
    await expect(t.listAll()).resolves.toEqual([
      {
        name: "alpha",
        windows: [
          { index: 0, name: "main", active: true, cwd: "/repo" },
          { index: 1, name: "empty", active: false, cwd: undefined },
        ],
      },
      { name: "beta", windows: [{ index: 3, name: "ops", active: true, cwd: "/srv" }] },
    ]);
    await expect(t.getPaneCommands(["alpha:0", "missing", "alpha:2"])).resolves.toEqual({
      "alpha:0": "bash",
      "alpha:2": "",
    });
  });

  test("pane info batching keeps fulfilled panes and swallows closed-pane races", async () => {
    const t = new RecordingTmux()
      .queue("list-panes", "node\t/repo\nignored\t/else", new Error("pane closed"), "\t");

    await expect(t.getPaneInfos(["alpha:0", "alpha:gone", "alpha:blank"])).resolves.toEqual({
      "alpha:0": { command: "node", cwd: "/repo" },
      "alpha:blank": { command: "", cwd: "" },
    });
  });

  test("resizers clamp fractional and out-of-range dimensions before best-effort tmux calls", async () => {
    const t = new RecordingTmux()
      .queue("resize-pane", "")
      .queue("resize-window", "");

    await expect(t.resizePane("alpha:0.0", 0.2, 999_999)).resolves.toBeUndefined();
    await expect(t.resizeWindow("alpha:0", 999_999, -4)).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "resize-pane", args: ["-t", "alpha:0.0", "-x", 1, "-y", 200] },
      { subcommand: "resize-window", args: ["-t", "alpha:0", "-x", 500, "-y", 1] },
    ]);
  });

  test("exitModeIfNeeded handles probe failures, normal panes, mode cancellation, and cancel races", async () => {
    const probeError = new RecordingTmux().queue("display-message", new Error("pane missing"));
    await expect(probeError.exitModeIfNeeded("alpha:0.0")).resolves.toBe(false);

    const notInMode = new RecordingTmux().queue("display-message", "0\n");
    await expect(notInMode.exitModeIfNeeded("alpha:0.0")).resolves.toBe(false);

    const cancelled = new RecordingTmux().queue("display-message", " 1 \n").queue("send-keys", "");
    await expect(cancelled.exitModeIfNeeded("alpha:0.0")).resolves.toBe(true);

    const race = new RecordingTmux()
      .queue("display-message", "1")
      .queue("send-keys", new Error("not in a mode"));
    await expect(race.exitModeIfNeeded("alpha:0.0")).resolves.toBe(false);

    const hardCancelFailure = new RecordingTmux()
      .queue("display-message", "1")
      .queue("send-keys", new Error("permission denied"));
    await expect(hardCancelFailure.exitModeIfNeeded("alpha:0.0")).rejects.toThrow("permission denied");
  });

  test("sendText covers long buffered sends, exhausted submit confirmation warnings, and capture failures", async () => {
    const pending = new SubmitProbeTmux();
    pending.captureScript = ["agent$ still pending", "agent% still pending", "agent> still pending", "agent❯ still pending"];

    await pending.sendText("alpha:0.0", "x".repeat(501));

    expect(pending.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "loadBuffer:501",
      "pasteBuffer",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
      "sendKeys:Enter",
      "capture:5",
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);

    const captureFails = new SubmitProbeTmux();
    captureFails.captureScript = [new Error("capture unavailable")];

    await captureFails.sendText("alpha:0.0", "short command");

    expect(captureFails.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:13:short comman",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
