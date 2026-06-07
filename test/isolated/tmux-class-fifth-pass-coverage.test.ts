import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

const hostExecMock = async () => "";

mock.module("../../src/config", () => mockConfigModule(() => ({
  host: "white.local",
  tmuxSocket: "/tmp/fifth-pass.sock",
})));
mock.module("../../src/core/transport/ssh", () => mockSshModule({
  hostExec: hostExecMock,
  ssh: hostExecMock,
}));

const { Tmux } = await import("../../src/core/transport/tmux-class.ts?tmux-class-fifth-pass");

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

class CaptureThrowTmux extends Tmux {
  calls: string[] = [];

  constructor() {
    super(undefined, "");
  }

  async capture(_target: string, lines = 80): Promise<string> {
    this.calls.push(`capture:${lines}`);
    throw new Error("capture failed");
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

describe("tmux-class fifth-pass isolated coverage", () => {
  beforeEach(() => {
    globalThis.setTimeout = immediateSetTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("grouped-session window selection and cleanup wrappers stay best-effort", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("select-window", new Error("window closed before select"))
      .queue("kill-session", new Error("session already gone"))
      .queue("kill-pane", new Error("pane already gone"));

    await expect(t.newGroupedSession("parent", "child", { window: "logs" })).resolves.toBeUndefined();
    await expect(t.killSession("child")).resolves.toBeUndefined();
    await expect(t.killPane("%9")).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "parent", "-s", "child"] },
      { subcommand: "select-window", args: ["-t", "child:logs"] },
      { subcommand: "kill-session", args: ["-t", "child"] },
      { subcommand: "kill-pane", args: ["-t", "%9"] },
    ]);
  });

  test("listPanes treats a tmux listing failure as an empty pane set", async () => {
    const t = new RecordingTmux().queue("list-panes", new Error("no tmux server"));

    await expect(t.listPanes()).resolves.toEqual([]);
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

  test("direct pane readers propagate tmux failures to callers", async () => {
    const windows = new RecordingTmux().queue("list-windows", new Error("window list failed"));
    await expect(windows.listWindows("alpha")).rejects.toThrow("window list failed");
    expect(windows.calls).toEqual([
      { subcommand: "list-windows", args: ["-t", "alpha", "-F", "#{window_index}:#{window_name}:#{window_active}"] },
    ]);

    const panes = new RecordingTmux()
      .queue("list-panes", new Error("command lookup failed"), new Error("info lookup failed"));
    await expect(panes.getPaneCommand("alpha:0.0")).rejects.toThrow("command lookup failed");
    await expect(panes.getPaneInfo("alpha:0.0")).rejects.toThrow("info lookup failed");
    expect(panes.calls).toEqual([
      { subcommand: "list-panes", args: ["-t", "alpha:0.0", "-F", "#{pane_current_command}"] },
      { subcommand: "list-panes", args: ["-t", "alpha:0.0", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
    ]);
  });

  test("exitModeIfNeeded rethrows hard cancel failures", async () => {
    const t = new RecordingTmux()
      .queue("display-message", "1")
      .queue("send-keys", new Error("permission denied"));

    await expect(t.exitModeIfNeeded("alpha:0.0")).rejects.toThrow("permission denied");
    expect(t.calls).toEqual([
      { subcommand: "display-message", args: ["-t", "alpha:0.0", "-p", "#{pane_in_mode}"] },
      { subcommand: "send-keys", args: ["-t", "alpha:0.0", "-X", "cancel"] },
    ]);
  });

  test("sendText treats capture failure as submitted and avoids retry loops", async () => {
    const t = new CaptureThrowTmux();

    await t.sendText("alpha:0.0", "hello");

    expect(t.calls).toEqual([
      "exitModeIfNeeded:alpha:0.0",
      "sendKeysLiteral:hello",
      "sendKeys:Enter",
      "capture:5",
    ]);
  });
});
