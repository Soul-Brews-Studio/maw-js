import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Tmux } from "../src/tmux";

// Capture all commands sent to ssh()
let commands: string[] = [];
let sshResult = "";

// Mock config to return no socket (tests expect plain "tmux" commands)
mock.module("../src/config", () => ({
  loadConfig: () => ({ host: "white.local" }),
  resetConfig: () => {},
}));

// Mock ssh module — intercept the command string
const mockExec = async (cmd: string, _host?: string) => {
  commands.push(cmd);
  return sshResult;
};
mock.module("../src/ssh", () => ({
  hostExec: mockExec,
  ssh: mockExec,
  // Stub: real findWindow is tested in 00-ssh.test.ts (loads first alphabetically)
  findWindow: () => null,
}));

// Ensure no socket env var leaks into tests
delete process.env.MAW_TMUX_SOCKET;

describe("Tmux", () => {
  let t: Tmux;

  beforeEach(() => {
    commands = [];
    sshResult = "";
    t = new Tmux();
  });

  // --- q() quoting (tested indirectly through commands) ---

  describe("quoting", () => {
    test("safe chars are not quoted", async () => {
      await t.tryRun("has-session", "-t", "my-session_01:3");
      expect(commands[0]).toBe("tmux has-session -t my-session_01:3");
    });

    test("special chars get single-quoted", async () => {
      await t.tryRun("send-keys", "-t", "s:0", "-l", "hello world");
      expect(commands[0]).toBe("tmux send-keys -t s:0 -l 'hello world'");
    });

    test("single quotes in values are escaped", async () => {
      await t.tryRun("send-keys", "-t", "s:0", "-l", "it's here");
      expect(commands[0]).toBe("tmux send-keys -t s:0 -l 'it'\\''s here'");
    });

    test("numbers are converted to strings", async () => {
      await t.tryRun("resize-pane", "-t", "s:0", "-x", 80, "-y", 24);
      expect(commands[0]).toBe("tmux resize-pane -t s:0 -x 80 -y 24");
    });
  });

  // --- Sessions ---

  describe("killSession", () => {
    test("generates kill-session command", async () => {
      await t.killSession("maw-pty-1");
      expect(commands).toEqual(["tmux kill-session -t maw-pty-1"]);
    });
  });

  describe("hasSession", () => {
    test("returns true when session exists", async () => {
      expect(await t.hasSession("oracles")).toBe(true);
      expect(commands[0]).toBe("tmux has-session -t oracles");
    });
  });

  describe("newSession", () => {
    test("basic detached session", async () => {
      await t.newSession("my-session");
      expect(commands[0]).toBe("tmux new-session -d -s my-session");
    });

    test("with window and cwd", async () => {
      await t.newSession("s1", { window: "main", cwd: "/home/nat" });
      expect(commands[0]).toBe("tmux new-session -d -s s1 -n main -c /home/nat");
    });

    test("non-detached", async () => {
      await t.newSession("s1", { detached: false });
      expect(commands[0]).toBe("tmux new-session -s s1");
    });
  });

  describe("newGroupedSession", () => {
    test("creates grouped session without destroy-unattached", async () => {
      await t.newGroupedSession("oracles", "maw-pty-1", { cols: 120, rows: 40 });
      expect(commands).toEqual([
        "tmux new-session -d -t oracles -s maw-pty-1 -x 120 -y 40",
      ]);
    });

    test("with window selection", async () => {
      await t.newGroupedSession("oracles", "maw-pty-2", { cols: 80, rows: 24, window: "3" });
      expect(commands).toEqual([
        "tmux new-session -d -t oracles -s maw-pty-2 -x 80 -y 24",
        "tmux select-window -t maw-pty-2:3",
      ]);
    });
  });

  // --- Windows ---

  describe("newWindow", () => {
    test("basic uses trailing colon on -t (next-free-index semantics)", async () => {
      await t.newWindow("oracles", "pulse-oracle");
      expect(commands[0]).toBe("tmux new-window -t oracles: -n pulse-oracle");
    });

    test("with cwd", async () => {
      await t.newWindow("oracles", "pulse", { cwd: "/home/nat/pulse" });
      expect(commands[0]).toBe("tmux new-window -t oracles: -n pulse -c /home/nat/pulse");
    });

    test("regression: never emits bare `-t <session>` (collides on base-index≠0)", async () => {
      // Without the trailing colon, tmux parses `-t neo` as
      // `-t neo:<current_window>` and errors with
      // "create window failed: index 1 in use" when the current
      // window sits at the base-index and is occupied.
      await t.newWindow("neo", "neo-mqtt-feed", { cwd: "/tmp/wt" });
      expect(commands[0]).toBe("tmux new-window -t neo: -n neo-mqtt-feed -c /tmp/wt");
      expect(commands[0]).not.toMatch(/-t neo\s/);
    });
  });

  describe("selectWindow", () => {
    test("generates select-window command", async () => {
      await t.selectWindow("oracles:3");
      expect(commands[0]).toBe("tmux select-window -t oracles:3");
    });
  });

  describe("killWindow", () => {
    test("generates kill-window command", async () => {
      await t.killWindow("oracles:2");
      expect(commands[0]).toBe("tmux kill-window -t oracles:2");
    });
  });

  describe("listWindows", () => {
    test("parses window list", async () => {
      sshResult = "0:neo-oracle:1\n1:pulse-oracle:0\n2:hermes-oracle:0";
      const windows = await t.listWindows("oracles");
      expect(windows).toEqual([
        { index: 0, name: "neo-oracle", active: true },
        { index: 1, name: "pulse-oracle", active: false },
        { index: 2, name: "hermes-oracle", active: false },
      ]);
    });
  });

  // --- Panes ---

  describe("resizePane", () => {
    test("clamps values", async () => {
      await t.resizePane("s:0", 9999, -5);
      expect(commands[0]).toBe("tmux resize-pane -t s:0 -x 500 -y 1");
    });

    test("floors fractional values", async () => {
      await t.resizePane("s:0", 80.7, 24.3);
      expect(commands[0]).toBe("tmux resize-pane -t s:0 -x 80 -y 24");
    });
  });

  describe("capture", () => {
    test("uses -S for lines > 50", async () => {
      sshResult = "some output";
      await t.capture("s:0", 80);
      expect(commands[0]).toBe("tmux capture-pane -t s:0 -e -p -S -80");
    });

    test("uses tail for lines <= 50", async () => {
      sshResult = "some output";
      await t.capture("s:0", 30);
      expect(commands[0]).toBe("tmux capture-pane -t s:0 -e -p 2>/dev/null | tail -30");
    });
  });

  describe("splitWindow", () => {
    test("generates split-window command", async () => {
      await t.splitWindow("oracles:page-1");
      expect(commands[0]).toBe("tmux split-window -t oracles:page-1");
    });
  });

  describe("selectPane", () => {
    test("without title", async () => {
      await t.selectPane("s:0.1");
      expect(commands[0]).toBe("tmux select-pane -t s:0.1");
    });

    test("with title", async () => {
      await t.selectPane("s:0.1", { title: "my pane" });
      expect(commands[0]).toBe("tmux select-pane -t s:0.1 -T 'my pane'");
    });
  });

  describe("selectLayout", () => {
    test("generates select-layout command", async () => {
      await t.selectLayout("oracles:page-1", "tiled");
      expect(commands[0]).toBe("tmux select-layout -t oracles:page-1 tiled");
    });
  });

  // --- Keys ---

  describe("sendKeys", () => {
    test("sends key names", async () => {
      await t.sendKeys("s:0", "Enter");
      expect(commands[0]).toBe("tmux send-keys -t s:0 Enter");
    });

    test("sends multiple keys", async () => {
      await t.sendKeys("s:0", "C-c", "Enter");
      expect(commands[0]).toBe("tmux send-keys -t s:0 C-c Enter");
    });
  });

  describe("sendKeysLiteral", () => {
    test("sends literal text with -l", async () => {
      await t.sendKeysLiteral("s:0", "hello world");
      expect(commands[0]).toBe("tmux send-keys -t s:0 -l 'hello world'");
    });

    test("escapes single quotes in text", async () => {
      await t.sendKeysLiteral("s:0", "it's a test");
      expect(commands[0]).toBe("tmux send-keys -t s:0 -l 'it'\\''s a test'");
    });
  });

  // --- Options ---

  describe("setOption", () => {
    test("generates set-option command", async () => {
      await t.setOption("s1", "destroy-unattached", "on");
      expect(commands[0]).toBe("tmux set-option -t s1 destroy-unattached on");
    });
  });

  describe("set", () => {
    test("generates set command", async () => {
      await t.set("s1", "status-style", "bg=colour235,fg=colour248");
      expect(commands[0]).toBe("tmux set -t s1 status-style 'bg=colour235,fg=colour248'");
    });
  });

  // --- Error handling ---

  describe("run", () => {
    test("propagates stderr from tmux errors (no 2>/dev/null swallow)", async () => {
      // Regression: tmux.run() previously wrapped every command with
      // `2>/dev/null`, making wake failures surface as bare "exit 1".
      const throwExec = async (_cmd: string) => { throw new Error("can't find session: neo"); };
      mock.module("../src/ssh", () => ({
        hostExec: throwExec,
        ssh: throwExec,
      }));
      const t2 = new Tmux();
      await expect(t2.run("list-windows", "-t", "neo")).rejects.toThrow("can't find session: neo");
    });

    test("built command does not include 2>/dev/null", async () => {
      let captured = "";
      const capExec = async (cmd: string) => { captured = cmd; return ""; };
      mock.module("../src/ssh", () => ({
        hostExec: capExec,
        ssh: capExec,
      }));
      const t2 = new Tmux();
      await t2.run("has-session", "-t", "neo");
      expect(captured).toBe("tmux has-session -t neo");
      expect(captured).not.toContain("2>/dev/null");
    });
  });

  describe("tryRun", () => {
    test("swallows errors", async () => {
      // Override mock to throw
      const orig = commands;
      const throwExec2 = async () => { throw new Error("session not found"); };
      mock.module("../src/ssh", () => ({
        hostExec: throwExec2,
        ssh: throwExec2,
      }));
      const t2 = new Tmux();
      const result = await t2.tryRun("kill-session", "-t", "nonexistent");
      expect(result).toBe("");
    });
  });

  // --- Host passthrough ---

  describe("host", () => {
    test("passes host to ssh", async () => {
      let capturedHost: string | undefined;
      const hostMock = async (_cmd: string, host?: string) => {
        capturedHost = host;
        return "";
      };
      mock.module("../src/ssh", () => ({
        hostExec: hostMock,
        ssh: hostMock,
      }));
      const remote = new Tmux("black.local");
      await remote.killSession("test");
      expect(capturedHost).toBe("black.local");
    });
  });
});
