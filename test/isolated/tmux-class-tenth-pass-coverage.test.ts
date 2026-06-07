import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("tmux-class tenth-pass isolated coverage", () => {
  beforeEach(() => {
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("newGroupedSession still selects a requested window after best-effort window-size failure", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("set-option", new Error("window-size unsupported"))
      .queue("select-window", "");

    await expect(t.newGroupedSession("parent", "child", {
      cols: 101,
      rows: 37,
      windowSize: "manual",
      window: "logs",
    })).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "parent", "-s", "child", "-x", 101, "-y", 37] },
      { subcommand: "set-option", args: ["-t", "child", "window-size", "manual"] },
      { subcommand: "select-window", args: ["-t", "child:logs"] },
    ]);
  });

  test("newSession keeps default-detached creation hard while renumbering stays best-effort", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("set-option", new Error("renumber option unavailable"));

    await expect(t.newSession("alpha")).resolves.toBe("");

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-s", "alpha"] },
      { subcommand: "set-option", args: ["-t", "alpha", "renumber-windows", "on"] },
    ]);
  });

  test("listSessions preserves blank window listings as empty sessions", async () => {
    const t = new RecordingTmux()
      .queue("list-sessions", "empty\n")
      .queue("list-windows", "\n");

    await expect(t.listSessions()).resolves.toEqual([{ name: "empty", windows: [] }]);

    expect(t.calls).toEqual([
      { subcommand: "list-sessions", args: ["-F", "#{session_name}"] },
      { subcommand: "list-windows", args: ["-t", "empty", "-F", "#{window_index}:#{window_name}:#{window_active}"] },
    ]);
  });

  test("listPanes preserves malformed truthy numeric fields instead of dropping the pane", async () => {
    const t = new RecordingTmux().queue(
      "list-panes",
      "%bad|||node|||alpha:debug.2|||debug|||not-a-pid|||/repo|||not-activity\n",
    );

    const panes = await t.listPanes();

    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      id: "%bad",
      command: "node",
      target: "alpha:debug.2",
      title: "debug",
      cwd: "/repo",
    });
    expect(Number.isNaN(panes[0].pid)).toBe(true);
    expect(Number.isNaN(panes[0].lastActivity)).toBe(true);
    expect(t.calls).toEqual([
      {
        subcommand: "list-panes",
        args: [
          "-a",
          "-F",
          "#{pane_id}|||#{pane_current_command}|||#{session_name}:#{window_name}.#{pane_index}|||#{pane_title}|||#{pane_pid}|||#{pane_current_path}|||#{window_activity}",
        ],
      },
    ]);
  });

  test("getPaneCommands fails soft when the batch pane command lookup errors", async () => {
    const t = new RecordingTmux()
      .queue("list-panes", new Error("tmux server unavailable"));

    await expect(t.getPaneCommands(["alpha:0", "alpha:1"])).resolves.toEqual({});

    expect(t.calls).toEqual([
      { subcommand: "list-panes", args: ["-a", "-F", "#{session_name}:#{window_index}|||#{pane_current_command}"] },
    ]);
  });

  test("sendText bases retry decisions on the final nonblank captured line", async () => {
    const t = new SubmitProbeTmux();
    t.captureScript = ["agent$ still pending from history\n\x1b[32magent$\x1b[0m \r\n"];

    await t.sendText("alpha:0.0", "already submitted");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:already submitted",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
