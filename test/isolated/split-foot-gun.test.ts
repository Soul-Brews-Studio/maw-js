/**
 * Regression tests for #1303 — `maw split` foot-gun refusal.
 *
 * The bug: `maw split <target> --no-attach` (no `--from`) falls back to
 * $TMUX_PANE as anchor, which means the CALLER's own pane gets carved.
 * When the caller is a Claude Code session, that slices the live AI pane —
 * almost never what the user intended.
 *
 * Fix: refuse outright when caller pane is claude-like and no explicit
 * anchor (`--from` for split, `-t` for pane split) was supplied. The
 * refusal message points at `maw shell` / `maw bg` (issue #1304) as
 * non-carve alternatives.
 *
 * Mirror gate exists in `src/commands/plugins/pane/split.ts` — both verbs
 * share the helper `callerPaneCarveRefusal` from tmux/safety.ts so the
 * error string is byte-identical.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mockSshModule } from "../helpers/mock-ssh";
import { mockConfigModule } from "../helpers/mock-config";

// Capture every tmux command + let each test stub the responder.
let commands: string[] = [];
let execResponder: (cmd: string) => string = () => "";

mock.module("../../src/config", () => mockConfigModule(() => ({ host: "white.local" })));

function installSshMock() {
  mock.module("../../src/core/transport/ssh", () =>
    mockSshModule({
      hostExec: async (cmd: string) => {
        commands.push(cmd);
        return execResponder(cmd);
      },
      ssh: async (cmd: string) => {
        commands.push(cmd);
        return execResponder(cmd);
      },
      listSessions: async () => [
        { name: "mawjs-yeast", windows: [{ index: 0 }] },
      ],
    }),
  );
}
installSshMock();

beforeEach(() => {
  commands = [];
  execResponder = () => "";
  installSshMock();
});

// Helper — set env so the guard sees a Claude pane and the `if (!TMUX)`
// preflight passes. Returns a cleanup fn that restores prior values.
function withTmuxPaneEnv(opts: { tmux?: string; pane?: string } = {}) {
  const prev = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  process.env.TMUX = opts.tmux ?? "/tmp/tmux-501/default,12345,0";
  process.env.TMUX_PANE = opts.pane ?? "%42";
  return () => {
    if (prev.TMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = prev.TMUX;
    if (prev.TMUX_PANE === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prev.TMUX_PANE;
  };
}

// ── cmdSplit refusal (the canonical #1303 regression) ──────────────────────

describe("cmdSplit — #1303 foot-gun refusal", () => {
  test("--no-attach + no --from from a Claude pane → refuses with helpful error", async () => {
    const restore = withTmuxPaneEnv({ pane: "%42" });
    // tmux display-message returns "claude" for the caller pane.
    execResponder = (cmd: string) => {
      if (cmd.startsWith("tmux display-message") && cmd.includes("%42")) {
        return "claude\n";
      }
      return "";
    };

    const { cmdSplit } = await import("../../src/commands/plugins/split/impl");
    try {
      await expect(cmdSplit("yeast", { noAttach: true })).rejects.toThrow(
        /refusing to carve caller's pane/,
      );
      // Verify it didn't fall through to the actual split-window invocation.
      expect(commands.some((c) => c.startsWith("tmux split-window"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("refusal message mentions maw shell, maw bg, and --from", async () => {
    const restore = withTmuxPaneEnv();
    execResponder = (cmd: string) =>
      cmd.startsWith("tmux display-message") ? "claude" : "";

    const { cmdSplit } = await import("../../src/commands/plugins/split/impl");
    try {
      let err: Error | undefined;
      await cmdSplit("yeast", { noAttach: true }).catch((e) => {
        err = e instanceof Error ? e : new Error(String(e));
      });
      expect(err).toBeDefined();
      expect(err!.message).toContain("maw shell");
      expect(err!.message).toContain("maw bg");
      expect(err!.message).toContain("--from");
      expect(err!.message).toContain("#1304");
    } finally {
      restore();
    }
  });

  test("--no-attach + --from <pane> → no refusal (explicit anchor)", async () => {
    const restore = withTmuxPaneEnv();
    // Even if the caller pane LOOKS claude-like, --from bypasses the gate.
    execResponder = (cmd: string) => {
      if (cmd.startsWith("tmux display-message")) return "claude";
      return "";
    };

    const { cmdSplit } = await import("../../src/commands/plugins/split/impl");
    try {
      await cmdSplit("yeast", { noAttach: true, anchorPane: "%99" });
      // Split actually happened — targeting %99, not %42.
      const split = commands.find((c) => c.startsWith("tmux split-window"));
      expect(split).toBeDefined();
      expect(split).toContain("%99");
    } finally {
      restore();
    }
  });

  test("non-Claude caller pane → no refusal", async () => {
    const restore = withTmuxPaneEnv();
    execResponder = (cmd: string) => {
      if (cmd.startsWith("tmux display-message")) return "bash";
      return "";
    };

    const { cmdSplit } = await import("../../src/commands/plugins/split/impl");
    try {
      await cmdSplit("yeast", { noAttach: true });
      const split = commands.find((c) => c.startsWith("tmux split-window"));
      expect(split).toBeDefined();
    } finally {
      restore();
    }
  });

  test("attach path (no --no-attach) is NOT gated — pre-existing behavior preserved", async () => {
    const restore = withTmuxPaneEnv();
    execResponder = (cmd: string) =>
      cmd.startsWith("tmux display-message") ? "claude" : "";

    const { cmdSplit } = await import("../../src/commands/plugins/split/impl");
    try {
      // No noAttach flag — attaching to a session in the new pane is a
      // separate use case (intentional carve to ferry a peer). Don't gate
      // here; the foot-gun is specifically about `--no-attach`.
      await cmdSplit("yeast", {});
      const split = commands.find((c) => c.startsWith("tmux split-window"));
      expect(split).toBeDefined();
      expect(split).toContain("attach-session");
    } finally {
      restore();
    }
  });
});

// ── cmdPaneSplit mirror gate ────────────────────────────────────────────────

describe("cmdPaneSplit — #1303 foot-gun refusal (mirror)", () => {
  test("no -t target from a Claude pane → refuses", async () => {
    const restore = withTmuxPaneEnv({ pane: "%42" });
    execResponder = (cmd: string) => {
      if (cmd.startsWith("tmux display-message") && cmd.includes("%42")) {
        return "claude";
      }
      return "";
    };

    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    try {
      await expect(cmdPaneSplit("", {})).rejects.toThrow(
        /refusing to carve caller's pane/,
      );
      expect(commands.some((c) => c.startsWith("tmux split-window"))).toBe(false);
    } finally {
      restore();
    }
  });

  test("explicit -t target bypasses the gate", async () => {
    const restore = withTmuxPaneEnv();
    execResponder = (cmd: string) =>
      cmd.startsWith("tmux display-message") ? "claude" : "";

    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    try {
      await cmdPaneSplit("echo hi", { target: "%999" });
      const split = commands.find((c) => c.startsWith("tmux split-window"));
      expect(split).toBeDefined();
      expect(split).toContain("%999");
    } finally {
      restore();
    }
  });

  test("non-Claude caller → no refusal, falls through to split", async () => {
    const restore = withTmuxPaneEnv();
    execResponder = (cmd: string) =>
      cmd.startsWith("tmux display-message") ? "bash" : "";

    const { cmdPaneSplit } = await import("../../src/commands/plugins/pane/split");
    try {
      await cmdPaneSplit("echo hi", {});
      const split = commands.find((c) => c.startsWith("tmux split-window"));
      expect(split).toBeDefined();
    } finally {
      restore();
    }
  });
});

// ── isClaudeLikePane + callerPaneCarveRefusal — unit-level sanity ──────────

describe("safety helpers", () => {
  test("isClaudeLikePane matches claude substring + version-y patterns", async () => {
    const { isClaudeLikePane } = await import(
      "../../src/commands/core/tmux/safety"
    );
    expect(isClaudeLikePane("claude")).toBe(true);
    expect(isClaudeLikePane("bun claude --foo")).toBe(true);
    expect(isClaudeLikePane("2.1.111")).toBe(true);
    expect(isClaudeLikePane("bash")).toBe(false);
    expect(isClaudeLikePane(undefined)).toBe(false);
    expect(isClaudeLikePane("")).toBe(false);
  });

  test("callerPaneCarveRefusal includes pane id + all three escape hatches", async () => {
    const { callerPaneCarveRefusal } = await import(
      "../../src/commands/core/tmux/safety"
    );
    const msg = callerPaneCarveRefusal("%42", "claude");
    expect(msg).toContain("%42");
    expect(msg).toContain("claude");
    expect(msg).toContain("maw shell");
    expect(msg).toContain("maw bg");
    expect(msg).toContain("--from");
    expect(msg).toContain("-t <pane>");
    expect(msg).toContain("#1304");
  });
});
