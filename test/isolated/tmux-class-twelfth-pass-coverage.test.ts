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

describe("tmux-class twelfth-pass isolated coverage", () => {
  test("session and pane existence helpers expose soft failure branches", async () => {
    const t = new RecordingTmux()
      .queue("has-session", "", new Error("missing session"))
      .queue("list-panes", "%1\n%2\n", new Error("no server"))
      .queue("list-windows", new Error("no server"));

    await expect(t.hasSession("alive")).resolves.toBe(true);
    await expect(t.hasSession("gone")).resolves.toBe(false);
    await expect(t.listPaneIds()).resolves.toEqual(new Set(["%1", "%2"]));
    await expect(t.listPaneIds()).resolves.toEqual(new Set());
    await expect(t.listAll()).resolves.toEqual([]);

    expect(t.calls).toEqual([
      { subcommand: "has-session", args: ["-t", "alive"] },
      { subcommand: "has-session", args: ["-t", "gone"] },
      { subcommand: "list-panes", args: ["-a", "-F", "#{pane_id}"] },
      { subcommand: "list-panes", args: ["-a", "-F", "#{pane_id}"] },
      { subcommand: "list-windows", args: ["-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}"] },
    ]);
  });

  test("creation and selection wrappers include optional arguments without softening hard commands", async () => {
    const t = new RecordingTmux()
      .queue("new-session", "")
      .queue("set-option", "")
      .queue("new-window", "")
      .queue("split-window", "")
      .queue("select-pane", "", "")
      .queue("select-layout", "")
      .queue("send-keys", "", "")
      .queue("paste-buffer", "")
      .queue("set-environment", "");

    await expect(t.newSession("alpha", { detached: false, window: "main", cwd: "/repo" })).resolves.toBe("");
    await expect(t.newWindow("alpha", "logs", { cwd: "/tmp" })).resolves.toBeUndefined();
    await expect(t.splitWindow("alpha:main.0")).resolves.toBe("");
    await expect(t.selectPane("alpha:main.0")).resolves.toBeUndefined();
    await expect(t.selectPane("alpha:main.0", { title: "worker" })).resolves.toBeUndefined();
    await expect(t.selectLayout("alpha:main", "tiled")).resolves.toBeUndefined();
    await expect(t.sendKeys("alpha:main.0", "C-c", "Enter")).resolves.toBeUndefined();
    await expect(t.sendKeysLiteral("alpha:main.0", "literal | text")).resolves.toBeUndefined();
    await expect(t.pasteBuffer("alpha:main.0")).resolves.toBeUndefined();
    await expect(t.setEnvironment("alpha", "MAW_TEST", "1")).resolves.toBeUndefined();

    expect(t.calls).toEqual([
      { subcommand: "new-session", args: ["-s", "alpha", "-n", "main", "-c", "/repo"] },
      { subcommand: "set-option", args: ["-t", "alpha", "renumber-windows", "on"] },
      { subcommand: "new-window", args: ["-t", "alpha:", "-n", "logs", "-c", "/tmp"] },
      { subcommand: "split-window", args: ["-t", "alpha:main.0"] },
      { subcommand: "select-pane", args: ["-t", "alpha:main.0"] },
      { subcommand: "select-pane", args: ["-t", "alpha:main.0", "-T", "worker"] },
      { subcommand: "select-layout", args: ["-t", "alpha:main", "tiled"] },
      { subcommand: "send-keys", args: ["-t", "alpha:main.0", "C-c", "Enter"] },
      { subcommand: "send-keys", args: ["-t", "alpha:main.0", "-l", "literal | text"] },
      { subcommand: "paste-buffer", args: ["-t", "alpha:main.0"] },
      { subcommand: "set-environment", args: ["-t", "alpha", "MAW_TEST", "1"] },
    ]);
  });

  test("best-effort wrappers swallow tmux races while direct pane readers keep their parsed defaults", async () => {
    const t = new RecordingTmux()
      .queue("select-window", new Error("window gone"))
      .queue("switch-client", new Error("not in tmux"))
      .queue("kill-window", new Error("already gone"))
      .queue("set", new Error("unsupported"))
      .queue("list-panes", "\n", "bash\t\nextra\tignored");

    await expect(t.selectWindow("alpha:missing")).resolves.toBeUndefined();
    await expect(t.switchClient("alpha")).resolves.toBeUndefined();
    await expect(t.killWindow("alpha:old")).resolves.toBeUndefined();
    await expect(t.set("alpha", "status", "off")).resolves.toBeUndefined();
    await expect(t.getPaneCommand("alpha:blank.0")).resolves.toBe("");
    await expect(t.getPaneInfo("alpha:shell.0")).resolves.toEqual({ command: "bash", cwd: "" });

    expect(t.calls).toEqual([
      { subcommand: "select-window", args: ["-t", "alpha:missing"] },
      { subcommand: "switch-client", args: ["-t", "alpha"] },
      { subcommand: "kill-window", args: ["-t", "alpha:old"] },
      { subcommand: "set", args: ["-t", "alpha", "status", "off"] },
      { subcommand: "list-panes", args: ["-t", "alpha:blank.0", "-F", "#{pane_current_command}"] },
      { subcommand: "list-panes", args: ["-t", "alpha:shell.0", "-F", "#{pane_current_command}\t#{pane_current_path}"] },
    ]);
  });
});
