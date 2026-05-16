import { describe, test, expect } from "bun:test";
import { buildAgentRows, type AgentRow } from "../src/commands/shared/agents";

// buildAgentRows is pure — no tmux, no I/O needed.

function makeWindowNames(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe("buildAgentRows — oracle detection", () => {
  test("oracle window is included and oracle name is extracted", () => {
    const panes = [{ command: "claude", target: "01-mawjs:mawjs-oracle.0", pid: 1234 }];
    const wn = makeWindowNames([["01-mawjs:0", "mawjs-oracle"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows).toHaveLength(1);
    expect(rows[0].oracle).toBe("mawjs");
    expect(rows[0].window).toBe("mawjs-oracle");
    expect(rows[0].session).toBe("01-mawjs");
    expect(rows[0].node).toBe("oracle-world");
    expect(rows[0].pid).toBe(1234);
  });

  test("legacy numeric pane target still resolves window name from listAll", () => {
    const panes = [{ command: "claude", target: "01-mawjs:0.0", pid: 1234 }];
    const wn = makeWindowNames([["01-mawjs:0", "mawjs-oracle"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: "01-mawjs",
      window: "mawjs-oracle",
      oracle: "mawjs",
    });
  });

  test("non-oracle window is excluded by default", () => {
    const panes = [{ command: "zsh", target: "01-mawjs:shell.0", pid: 5678 }];
    const wn = makeWindowNames([["01-mawjs:1", "shell"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows).toHaveLength(0);
  });

  test("non-oracle window is included with --all", () => {
    const panes = [{ command: "zsh", target: "01-mawjs:shell.0", pid: 5678 }];
    const wn = makeWindowNames([["01-mawjs:1", "shell"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world", { all: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].oracle).toBe("");
    expect(rows[0].window).toBe("shell");
  });
});

describe("buildAgentRows — state detection", () => {
  test("shell command produces idle state", () => {
    const panes = [{ command: "zsh", target: "02-neo:neo-oracle.0", pid: 999 }];
    const wn = makeWindowNames([["02-neo:0", "neo-oracle"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows[0].state).toBe("idle");
  });

  test("non-shell command produces active state", () => {
    const panes = [{ command: "claude", target: "02-neo:neo-oracle.0", pid: 888 }];
    const wn = makeWindowNames([["02-neo:0", "neo-oracle"]]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows[0].state).toBe("active");
  });

  test("multiple panes: mix of oracle and non-oracle, mix of states", () => {
    const panes = [
      { command: "claude", target: "01-mawjs:mawjs-oracle.0", pid: 100 },
      { command: "zsh",    target: "02-neo:neo-oracle.0",     pid: 200 },
      { command: "bash",   target: "03-shell:shell.0",        pid: 300 }, // non-oracle
    ];
    const wn = makeWindowNames([
      ["01-mawjs:0", "mawjs-oracle"],
      ["02-neo:0",   "neo-oracle"],
      ["03-shell:0", "shell"],
    ]);
    const rows = buildAgentRows(panes, wn, "oracle-world");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ oracle: "mawjs", state: "active", pid: 100 });
    expect(rows[1]).toMatchObject({ oracle: "neo", state: "idle", pid: 200 });
  });
});
