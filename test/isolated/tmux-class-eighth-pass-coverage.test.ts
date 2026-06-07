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

describe("tmux-class eighth-pass isolated coverage", () => {
  test("newGroupedSession selects the requested window even without window-size tuning", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("select-window", "");

    await t.newGroupedSession("alpha", "alpha-view", { window: "3" });

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-d", "-t", "alpha", "-s", "alpha-view"] },
      { subcommand: "select-window", args: ["-t", "alpha-view:3"] },
    ]);
  });

  test("listPanes fails soft when tmux cannot list panes at all", async () => {
    const t = new RecordingTmux()
      .queue("list-panes", new Error("tmux down"));

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
});
