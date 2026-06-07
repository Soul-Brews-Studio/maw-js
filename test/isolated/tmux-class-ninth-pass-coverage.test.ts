import { describe, expect, test } from "bun:test";
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

describe("tmux-class ninth-pass isolated coverage", () => {
  test("capture switches to tmux scrollback start args for requests beyond tail-safe size", async () => {
    const t = new RecordingTmux().queue("capture-pane", "long scrollback");

    await expect(t.capture("alpha:logs.0", 51)).resolves.toBe("long scrollback");

    expect(t.calls).toEqual([
      { subcommand: "capture-pane", args: ["-t", "alpha:logs.0", "-e", "-p", "-S", -51] },
    ]);
  });

  test("grouped-session window selection and session cleanup stay soft across tmux races", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("select-window", new Error("window closed before select"))
      .queue("kill-session", new Error("session already gone"));

    await expect(t.newGroupedSession("alpha", "alpha-view", {
      cols: 132,
      window: "logs",
    })).resolves.toBeUndefined();
    await expect(t.killSession("alpha-view")).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "alpha", "-s", "alpha-view", "-x", 132] },
      { subcommand: "select-window", args: ["-t", "alpha-view:logs"] },
      { subcommand: "kill-session", args: ["-t", "alpha-view"] },
    ]);
  });

  test("listPanes failure and pane cleanup both collapse to empty/no-op results", async () => {
    const t = new RecordingTmux()
      .queue("list-panes", new Error("tmux server unavailable"))
      .queue("kill-pane", new Error("pane already closed"));

    await expect(t.listPanes()).resolves.toEqual([]);
    await expect(t.killPane("%13")).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      {
        subcommand: "list-panes",
        args: [
          "-a",
          "-F",
          "#{pane_id}|||#{pane_current_command}|||#{session_name}:#{window_name}.#{pane_index}|||#{pane_title}|||#{pane_pid}|||#{pane_current_path}|||#{window_activity}",
        ],
      },
      { subcommand: "kill-pane", args: ["-t", "%13"] },
    ]);
  });
});
