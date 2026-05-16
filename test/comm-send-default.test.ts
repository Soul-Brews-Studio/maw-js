import { afterEach, describe, expect, test } from "bun:test";
import {
  checkPaneIdle,
  formatSignedMessage,
  resolveMyName,
  resolveOraclePane,
} from "../src/commands/shared/comm-send";

describe("resolveOraclePane — default coverage seams", () => {
  test("honors pane-specific targets without consulting tmux", async () => {
    let called = false;

    const out = await resolveOraclePane("54-mawjs:mawjs-oracle.2", {
      tmuxRun: async () => {
        called = true;
        throw new Error("should not run tmux for pane-specific targets");
      },
    });

    expect(out).toBe("54-mawjs:mawjs-oracle.2");
    expect(called).toBe(false);
  });

  test("leaves single-pane windows unchanged", async () => {
    const out = await resolveOraclePane("54-mawjs:mawjs-oracle", {
      tmuxRun: async (...args: string[]) => {
        expect(args).toEqual([
          "list-panes",
          "-t",
          "54-mawjs:mawjs-oracle",
          "-F",
          "#{pane_index} #{pane_current_command}",
        ]);
        return "0 zsh\n";
      },
    });

    expect(out).toBe("54-mawjs:mawjs-oracle");
  });

  test("chooses the lowest-index agent pane from multi-pane windows", async () => {
    const out = await resolveOraclePane("54-mawjs:mawjs-oracle", {
      tmuxRun: async () => [
        "0 zsh",
        "3 codex",
        "1 claude",
        "2 node",
      ].join("\n"),
      isAgentCommandFn: (cmd: string) => ["claude", "codex", "node"].includes(cmd),
    });

    expect(out).toBe("54-mawjs:mawjs-oracle.1");
  });

  test("skips malformed pane rows before choosing an agent", async () => {
    const out = await resolveOraclePane("54-mawjs:mawjs-oracle", {
      tmuxRun: async () => [
        "not-a-pane-row",
        "NaN claude",
        "4 zsh",
        "2 claude",
      ].join("\n"),
      isAgentCommandFn: (cmd: string) => cmd === "claude",
    });

    expect(out).toBe("54-mawjs:mawjs-oracle.2");
  });

  test("leaves multi-pane windows unchanged when no agent pane exists", async () => {
    const out = await resolveOraclePane("54-mawjs:mawjs-oracle", {
      tmuxRun: async () => "0 zsh\n1 bash\n",
      isAgentCommandFn: () => false,
    });

    expect(out).toBe("54-mawjs:mawjs-oracle");
  });

  test("leaves targets unchanged when tmux pane listing fails", async () => {
    const out = await resolveOraclePane("54-mawjs:mawjs-oracle", {
      tmuxRun: async () => {
        throw new Error("tmux unavailable");
      },
    });

    expect(out).toBe("54-mawjs:mawjs-oracle");
  });
});

describe("checkPaneIdle — default coverage seams", () => {
  test("treats an empty shell prompt as idle", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => "previous output\nuser@host:~$ ",
    });

    expect(out).toEqual({ idle: true, lastInput: "" });
  });

  test("treats a zsh prompt with no typed input as idle", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => "❯ ",
    });

    expect(out).toEqual({ idle: true, lastInput: "" });
  });

  test("returns typed input after a prompt marker", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => "❯ maw hey le:hojo hi",
    });

    expect(out).toEqual({ idle: false, lastInput: "maw hey le:hojo hi" });
  });

  test("strips ANSI escape sequences before detecting typed input", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => "\x1b[32m❯\x1b[0m maw ls",
    });

    expect(out).toEqual({ idle: false, lastInput: "maw ls" });
  });

  test("treats command output with no visible prompt as idle", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => "building...\nstill running",
    });

    expect(out).toEqual({ idle: true, lastInput: "" });
  });

  test("treats capture failures as idle", async () => {
    const out = await checkPaneIdle("54-mawjs:mawjs-oracle.0", undefined, {
      captureFn: async () => {
        throw new Error("capture failed");
      },
    });

    expect(out).toEqual({ idle: true, lastInput: "" });
  });

  test("forwards target, line count, and host to the capture dependency", async () => {
    const seen: unknown[][] = [];
    await checkPaneIdle("mba:48-mawjs:oracle.0", "mba", {
      captureFn: async (...args: unknown[]) => {
        seen.push(args);
        return "❯ ";
      },
    });

    expect(seen).toEqual([["mba:48-mawjs:oracle.0", 5, "mba"]]);
  });
});

describe("resolveMyName — environment attribution", () => {
  const originalName = process.env.CLAUDE_AGENT_NAME;

  afterEach(() => {
    if (originalName === undefined) {
      delete process.env.CLAUDE_AGENT_NAME;
    } else {
      process.env.CLAUDE_AGENT_NAME = originalName;
    }
  });

  test("uses CLAUDE_AGENT_NAME before shelling out to tmux", () => {
    process.env.CLAUDE_AGENT_NAME = "mawjs-codex";

    expect(resolveMyName({ node: "m5" } as never)).toBe("mawjs-codex");
  });
});

describe("formatSignedMessage — edge branches", () => {
  test("leaves empty and whitespace-only messages unchanged", () => {
    expect(formatSignedMessage("", { node: "m5" }, "mawjs-codex")).toBe("");
    expect(formatSignedMessage("   ", { node: "m5" }, "mawjs-codex")).toBe("   ");
  });

  test("falls back to local when config.node is absent", () => {
    expect(formatSignedMessage("hello", {}, "mawjs-codex")).toBe("[local:mawjs-codex] hello");
  });

  test("does not double-prefix after leading whitespace", () => {
    expect(formatSignedMessage("  [m5:mawjs-codex] hello", { node: "m5" }, "mawjs-codex"))
      .toBe("  [m5:mawjs-codex] hello");
  });
});
