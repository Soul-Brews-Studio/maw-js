import { afterEach, describe, expect, test } from "bun:test";
import {
  attachToSession,
  createWorktree,
  ensureSessionRunning,
  isPaneIdle,
} from "../src/commands/shared/wake-session";

const originalTmux = process.env.TMUX;

afterEach(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

function makeTmux(overrides: Record<string, unknown> = {}) {
  return {
    switchClient: async () => {},
    listWindows: async () => [] as Array<{ index: number; name: string; active: boolean }>,
    getPaneCommands: async () => ({} as Record<string, string>),
    sendText: async () => {},
    ...overrides,
  } as any;
}

describe("wake-session dependency seam", () => {
  test("attachToSession switches tmux clients inside tmux", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    const calls: string[] = [];

    await attachToSession("54-mawjs", {
      tmux: makeTmux({ switchClient: async (session: string) => calls.push(session) }),
      execSync: (() => { throw new Error("should not attach"); }) as any,
    });

    expect(calls).toEqual(["54-mawjs"]);
  });

  test("attachToSession attaches a fresh shell outside tmux", async () => {
    delete process.env.TMUX;
    const calls: Array<{ cmd: string; opts: unknown }> = [];

    await attachToSession("54-mawjs", {
      tmux: makeTmux({ switchClient: async () => { throw new Error("should not switch"); } }),
      execSync: ((cmd: string, opts: unknown) => calls.push({ cmd, opts })) as any,
    });

    expect(calls).toEqual([{ cmd: "tmux attach-session -t 54-mawjs", opts: { stdio: "inherit" } }]);
  });
});

describe("isPaneIdle", () => {
  test("returns true when pane pid is empty or has no children", async () => {
    expect(await isPaneIdle("s:win", { hostExec: async () => "\n" })).toBe(true);

    const commands: string[] = [];
    const idle = await isPaneIdle("s:win", {
      hostExec: async (cmd: string) => {
        commands.push(cmd);
        return cmd.includes("display-message") ? "123\n" : "\n";
      },
    });

    expect(idle).toBe(true);
    expect(commands).toEqual([
      "tmux display-message -t 's:win' -p '#{pane_pid}'",
      "pgrep -P 123 2>/dev/null || true",
    ]);
  });

  test("returns false for child processes and true on host errors", async () => {
    expect(await isPaneIdle("s:win", {
      hostExec: async (cmd: string) => cmd.includes("display-message") ? "123\n" : "456\n",
    })).toBe(false);

    expect(await isPaneIdle("s:win", {
      hostExec: async () => { throw new Error("tmux unavailable"); },
    })).toBe(true);
  });
});

describe("ensureSessionRunning", () => {
  test("returns 0 when windows cannot be listed", async () => {
    const retried = await ensureSessionRunning("missing", undefined, undefined, {
      tmux: makeTmux({ listWindows: async () => { throw new Error("missing"); } }),
    });
    expect(retried).toBe(0);
  });

  test("retries idle shell panes, skips excluded, busy, and non-shell windows", async () => {
    const sent: Array<{ target: string; cmd: string }> = [];
    const logs: string[] = [];
    const hostCommands: string[] = [];
    const panePids: Record<string, string> = {
      "s:idle": "111\n",
      "s:busy": "222\n",
      "s:cwd": "333\n",
      "s:empty": "444\n",
    };

    const retried = await ensureSessionRunning(
      "s",
      new Set(["skip"]),
      { cwd: "/work/cwd" },
      {
        tmux: makeTmux({
          listWindows: async () => [
            { index: 0, name: "idle", active: true },
            { index: 1, name: "busy", active: false },
            { index: 2, name: "node", active: false },
            { index: 3, name: "skip", active: false },
            { index: 4, name: "cwd", active: false },
            { index: 5, name: "empty", active: false },
            { index: 6, name: "killed", active: false },
          ],
          getPaneCommands: async () => ({
            "s:idle": "zsh",
            "s:busy": "bash",
            "s:node": "node",
            "s:skip": "zsh",
            "s:cwd": "sh",
            "s:empty": "",
            "s:killed": "zsh",
          }),
          sendText: async (target: string, cmd: string) => {
            if (target === "s:killed") throw new Error("gone");
            sent.push({ target, cmd });
          },
        }),
        hostExec: async (cmd: string) => {
          hostCommands.push(cmd);
          if (cmd.includes("display-message")) {
            const target = cmd.match(/-t '([^']+)'/)?.[1] ?? "";
            return panePids[target] ?? "555\n";
          }
          if (cmd.includes("pgrep -P 222")) return "999\n";
          return "\n";
        },
        sleep: async () => {},
        cfgTimeout: () => 0,
        buildCommand: (name: string) => `run ${name}`,
        buildCommandInDir: (name: string, cwd: string) => `cd ${cwd} && run ${name}`,
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      },
    );

    expect(retried).toBe(3);
    expect(sent).toEqual([
      { target: "s:idle", cmd: "run idle" },
      { target: "s:cwd", cmd: "cd /work/cwd && run cwd" },
      { target: "s:empty", cmd: "run empty" },
    ]);
    expect(logs.join("\n")).toContain("retry: idle");
    expect(logs.join("\n")).toContain("retry: cwd");
    expect(logs.join("\n")).toContain("retry: empty (was empty)");
    expect(hostCommands.some(cmd => cmd.includes("s:skip"))).toBe(false);
    expect(hostCommands.some(cmd => cmd.includes("s:node"))).toBe(false);
  });
});

describe("createWorktree", () => {
  test("defaults to the lowest reusable target-specific slot instead of global max+1", async () => {
    const commands: string[] = [];
    const result = await createWorktree(
      "/repo",
      "/tmp",
      "repo",
      "oracle",
      "white",
      [
        { name: "1-alpha", path: "/tmp/repo.wt-1-alpha" },
        { name: "2-beta", path: "/tmp/repo.wt-2-beta" },
      ],
      {
        hostExec: async (cmd: string) => {
          commands.push(cmd);
          if (cmd.includes("rev-parse HEAD")) return "abc\n";
          if (cmd.includes("show-ref")) throw new Error("missing branch");
          return "";
        },
        log: () => {},
      },
    );

    expect(result).toEqual({ wtPath: "/tmp/repo.wt-1-white", windowName: "oracle-white" });
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-1-white' -b 'agents/1-white'");
  });

  test("reattaches an existing branch for the stable slot when the worktree dir is gone", async () => {
    const commands: string[] = [];
    const logs: string[] = [];

    const result = await createWorktree("/repo", "/tmp", "repo", "oracle", "white", [], {
      hostExec: async (cmd: string) => {
        commands.push(cmd);
        if (cmd.includes("rev-parse HEAD")) return "abc\n";
        if (cmd.includes("show-ref")) return "";
        return "";
      },
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    });

    expect(result.wtPath).toBe("/tmp/repo.wt-1-white");
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-1-white' 'agents/1-white'");
    expect(logs.join("\n")).toContain("reused branch");
  });

  test("fresh mode keeps the old max+1 behavior for one-shot worktrees", async () => {
    const commands: string[] = [];

    const result = await createWorktree(
      "/repo",
      "/tmp",
      "repo",
      "oracle",
      "white",
      [{ name: "7-alpha", path: "/tmp/repo.wt-7-alpha" }],
      {
        fresh: true,
        hostExec: async (cmd: string) => {
          commands.push(cmd);
          if (cmd.includes("rev-parse HEAD")) return "abc\n";
          if (cmd.includes("show-ref")) throw new Error("missing branch");
          return "";
        },
        log: () => {},
      },
    );

    expect(result).toEqual({ wtPath: "/tmp/repo.wt-8-white", windowName: "oracle-white" });
    expect(commands).toContain("git -C '/repo' worktree add '/tmp/repo.wt-8-white' -b 'agents/8-white'");
  });

  test("bootstraps unborn repos, escapes shell args, and errors after allocation exhaustion", async () => {
    const commands: string[] = [];
    await createWorktree("/repo's", "/tmp", "repo", "oracle", "white", [], {
      hostExec: async (cmd: string) => {
        commands.push(cmd);
        if (cmd.includes("rev-parse HEAD")) throw new Error("unborn");
        if (cmd.includes("show-ref")) throw new Error("missing branch");
        return "";
      },
      log: () => {},
    });

    expect(commands[0]).toBe("git -C '/repo'\\''s' rev-parse HEAD 2>/dev/null");
    expect(commands[1]).toBe("git -C '/repo'\\''s' commit --allow-empty -m \"init: bootstrap for worktree\"");

    const existing = Array.from({ length: 1000 }, (_, i) => ({
      name: `${i + 1}-white`,
      path: `/tmp/repo.wt-${i + 1}-white`,
    }));
    await expect(createWorktree("/repo", "/tmp", "repo", "oracle", "white", existing, {
      hostExec: async (cmd: string) => cmd.includes("rev-parse") ? "abc\n" : "",
      log: () => {},
    })).rejects.toThrow("could not allocate worktree for white");
  });
});
