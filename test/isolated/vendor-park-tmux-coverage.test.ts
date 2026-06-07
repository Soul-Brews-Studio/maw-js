import { afterEach, describe, expect, mock, test } from "bun:test";

type SpawnResult = { status: number; stdout?: string; stderr?: string };
const calls: Array<{ command: string; args: string[]; opts: Record<string, unknown> }> = [];
let queue: SpawnResult[] = [];

mock.module("node:child_process", () => ({
  spawnSync: (command: string, args: string[], opts: Record<string, unknown> = {}) => {
    calls.push({ command, args, opts });
    return queue.shift() ?? { status: 0, stdout: "", stderr: "" };
  },
}));

const realSetTimeout = globalThis.setTimeout;
const { tmuxRun, tmuxListWindows, tmuxSendText } = await import("../../src/vendor/mpr-plugins/park/src/internal/tmux.ts?vendor-park-tmux-coverage");

afterEach(() => {
  calls.length = 0;
  queue = [];
  globalThis.setTimeout = realSetTimeout;
});

describe("park vendor tmux helpers", () => {
  test("tmuxRun returns trimmed stdout and surfaces stderr or exit fallback", () => {
    queue = [{ status: 0, stdout: "  ok\n", stderr: "" }];
    expect(tmuxRun("display-message", "-p", "#S")).toBe("ok");
    expect(calls[0]).toMatchObject({ command: "tmux", args: ["display-message", "-p", "#S"] });

    queue = [{ status: 1, stdout: "", stderr: " denied\n" }];
    expect(() => tmuxRun("list-windows")).toThrow("denied");

    queue = [{ status: 2, stdout: "", stderr: "" }];
    expect(() => tmuxRun("capture-pane")).toThrow("tmux capture-pane failed (exit 2)");
  });

  test("tmuxListWindows parses empty and named windows", () => {
    queue = [{ status: 0, stdout: "\n", stderr: "" }];
    expect(tmuxListWindows("empty")).toEqual([]);

    queue = [{ status: 0, stdout: "0:editor\n2:logs:tail\n", stderr: "" }];
    expect(tmuxListWindows("dev")).toEqual([
      { index: 0, name: "editor" },
      { index: 2, name: "logs:tail" },
    ]);
  });

  test("tmuxSendText uses load-buffer, paste-buffer, and two Enter sends", async () => {
    globalThis.setTimeout = ((cb: (...args: unknown[]) => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    await tmuxSendText("dev:1.0", "hello\nworld");

    expect(calls.map((c) => c.args)).toEqual([
      ["load-buffer", "-"],
      ["paste-buffer", "-t", "dev:1.0"],
      ["send-keys", "-t", "dev:1.0", "Enter"],
      ["send-keys", "-t", "dev:1.0", "Enter"],
    ]);
    expect(calls[0].opts).toMatchObject({ input: "hello\nworld", encoding: "utf8" });
  });
});
