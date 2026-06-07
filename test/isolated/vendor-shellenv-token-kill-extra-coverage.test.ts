import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type SessionLike = {
  name: string;
  windows?: Array<{ index?: number; name?: string; repo?: string }>;
};

let sessions: SessionLike[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => string | Promise<string> = () => "";

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  tmuxCmd: () => "tmux",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return await hostExecImpl(cmd);
  },
}));

const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl.ts?vendor-shellenv-token-kill-extra");
const { cmdShellenv, SUPPORTED_SHELLS } = await import(
  "../../src/vendor/mpr-plugins/shellenv/src/impl.ts?vendor-shellenv-token-kill-extra"
);
const { UserError: ShellenvUserError, isUserError: isShellenvUserError } = await import(
  "../../src/vendor/mpr-plugins/shellenv/src/internal/user-error.ts?vendor-shellenv-token-kill-extra"
);
const { zshSnippet } = await import(
  "../../src/vendor/mpr-plugins/shellenv/src/snippets/zsh.ts?vendor-shellenv-token-kill-extra"
);
const { cmdList, formatList } = await import("../../src/vendor/mpr-plugins/token/list");
const { setRunOverride } = await import("../../src/vendor/mpr-plugins/token/lib");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "maw-vendor-shellenv-token-kill-"));

const originalConsole = {
  log: console.log,
  error: console.error,
};

function runResult(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1) {
  return { ok, stdout, stderr, exitCode };
}

async function captureConsole<T>(fn: () => T | Promise<T>) {
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
  }
}

beforeEach(() => {
  sessions = [];
  hostExecCalls = [];
  hostExecImpl = () => "";
  setRunOverride(null);
});

afterEach(() => {
  setRunOverride(null);
  console.log = originalConsole.log;
  console.error = originalConsole.error;
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("vendor kill implementation branch coverage", () => {
  test("rejects a missing target before querying tmux", async () => {
    const { errors } = await captureConsole(async () => {
      await expect(cmdKill("")).rejects.toThrow("usage: maw kill <target>[:window] [--pane N]");
    });

    expect(errors.join("\n")).toContain("usage: maw kill <target>[:window] [--pane N]");
    expect(hostExecCalls).toEqual([]);
  });

  test("surfaces ambiguous session matches with candidate names", async () => {
    sessions = [
      { name: "11-demo", windows: [{ index: 0 }] },
      { name: "22-demo", windows: [{ index: 1 }] },
    ];

    const { errors } = await captureConsole(async () => {
      await expect(cmdKill("demo")).rejects.toThrow("'demo' is ambiguous");
    });

    expect(errors.join("\n")).toContain("matches 2 sessions");
    expect(errors.join("\n")).toContain("11-demo");
    expect(errors.join("\n")).toContain("22-demo");
    expect(hostExecCalls).toEqual([]);
  });

  test("uses pane fallback for orphan pane aliases and refuses ambiguous pane aliases", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.includes("list-panes -a -F")) {
        return [
          "%101|||47-mawjs:1.0|||codex-headless-demo-layout|||tile-1|||/tmp/mawjs-oracle.wt-7-codex-headless",
          "%202|||47-mawjs:1.1|||notes|||worker|||/tmp/mawjs-oracle.wt-8-worker",
          "%303|||47-mawjs:1.2|||scratch|||worker|||/tmp/mawjs-oracle.wt-9-worker",
        ].join("\n");
      }
      if (cmd.includes("kill-pane -t '%101'")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const matched = await captureConsole(() => cmdKill("mawjs-codex-headless"));
    expect(matched.logs.join("\n")).toContain("killed pane mawjs-codex-headless");
    expect(hostExecCalls).toEqual([
      "tmux list-panes -a -F '#{pane_id}|||#{session_name}:#{window_index}.#{pane_index}|||#{pane_title}|||#{@maw_tile_role}|||#{pane_current_path}'",
      "tmux kill-pane -t '%101'",
    ]);

    hostExecCalls = [];
    const ambiguous = await captureConsole(async () => {
      await expect(cmdKill("worker")).rejects.toThrow("'worker' is ambiguous");
    });
    expect(ambiguous.errors.join("\n")).toContain("matches 2 panes");
    expect(ambiguous.errors.join("\n")).toContain("%202");
    expect(ambiguous.errors.join("\n")).toContain("%303");
  });

  test("renders not-found hints and no-hint guidance after pane fallback misses or is skipped", async () => {
    sessions = [{ name: "mawjs-view", windows: [{ index: 0 }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("list-panes -a -F")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    const hinted = await captureConsole(async () => {
      await expect(cmdKill("wjs")).rejects.toThrow("session 'wjs' not found");
    });
    expect(hinted.errors.join("\n")).toContain("did you mean");
    expect(hinted.errors.join("\n")).toContain("mawjs-view");

    sessions = [];
    hostExecCalls = [];
    const noHints = await captureConsole(async () => {
      await expect(cmdKill("ghost:2")).rejects.toThrow("session 'ghost' not found");
    });
    expect(noHints.errors.join("\n")).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("validates pane indexes, wraps list failures, and reports kill-pane failures", async () => {
    sessions = [{ name: "47-mawjs", windows: [{ index: 3 }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("list-panes -t '47-mawjs:3'")) return "3\nnot-a-number\n4\n";
      if (cmd.includes("kill-pane -t '47-mawjs:3.4'")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    await expect(captureConsole(() => cmdKill("mawjs", { pane: 4 }))).resolves.toMatchObject({
      logs: [expect.stringContaining("killed pane 47-mawjs:3.4")],
    });
    expect(hostExecCalls.at(-2)).toContain("list-panes -t '47-mawjs:3'");
    expect(hostExecCalls.at(-1)).toContain("kill-pane -t '47-mawjs:3.4'");

    hostExecImpl = () => "";
    await expect(cmdKill("mawjs", { pane: 0 })).rejects.toThrow(
      "pane 0 does not exist in window 47-mawjs:3 (valid: (none))",
    );

    hostExecImpl = () => {
      throw new Error("tmux list failed");
    };
    await expect(cmdKill("mawjs", { pane: 0 })).rejects.toThrow(
      "list-panes failed for 47-mawjs:3: tmux list failed",
    );

    hostExecImpl = (cmd) => {
      if (cmd.includes("list-panes -t '47-mawjs:3'")) return "4\n";
      if (cmd.includes("kill-pane -t '47-mawjs:3.4'")) throw new Error("permission denied");
      throw new Error(`unexpected command: ${cmd}`);
    };
    await expect(cmdKill("mawjs", { pane: 4 })).rejects.toThrow("kill-pane failed: permission denied");
  });

  test("kills windows and sessions, wrapping tmux failures with action-specific messages", async () => {
    sessions = [{ name: "47-mawjs", windows: [{ index: 0 }, { index: 1 }] }];
    hostExecImpl = (cmd) => {
      if (cmd.includes("kill-window -t '47-mawjs:1'")) return "";
      if (cmd.includes("kill-session -t '47-mawjs'")) return "";
      throw new Error(`unexpected command: ${cmd}`);
    };

    await expect(captureConsole(() => cmdKill("mawjs:1"))).resolves.toMatchObject({
      logs: [expect.stringContaining("killed window 47-mawjs:1")],
    });
    await expect(captureConsole(() => cmdKill("mawjs"))).resolves.toMatchObject({
      logs: [expect.stringContaining("killed session 47-mawjs")],
    });

    hostExecImpl = (cmd) => {
      if (cmd.includes("kill-window")) throw new Error("window busy");
      if (cmd.includes("kill-session")) throw new Error("session busy");
      throw new Error(`unexpected command: ${cmd}`);
    };

    await expect(cmdKill("mawjs:1")).rejects.toThrow("kill-window failed: window busy");
    await expect(cmdKill("mawjs")).rejects.toThrow("kill-session failed: session busy");
  });
});

describe("shellenv implementation and zsh snippet coverage", () => {
  test("inlined UserError guard accepts branded plugin errors and rejects impostors", () => {
    const err = new ShellenvUserError("missing shell");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UserError");
    expect(err.isUserError).toBe(true);
    expect(isShellenvUserError(err)).toBe(true);
    expect(isShellenvUserError(new Error("plain"))).toBe(false);
    expect(isShellenvUserError({ isUserError: true })).toBe(false);
  });

  test("prints help before validating shell and lists supported shells", async () => {
    const { logs } = await captureConsole(() => cmdShellenv(undefined, { help: true }));

    expect(logs.join("\n")).toContain("usage: maw shellenv <shell>");
    expect(logs.join("\n")).toContain(`Available shells: ${SUPPORTED_SHELLS.join(", ")}`);
  });

  test("rejects missing and unsupported shell names with user-facing errors", async () => {
    const missing = await captureConsole(async () => {
      await expect(cmdShellenv(undefined)).rejects.toThrow("missing shell argument");
    });
    expect(missing.errors.join("\n")).toContain("shell '' not supported");

    const unsupported = await captureConsole(async () => {
      await expect(cmdShellenv("fish")).rejects.toThrow("unsupported shell: fish");
    });
    expect(unsupported.errors.join("\n")).toContain("shell 'fish' not supported");
  });

  test("emits zsh and bash snippets through the shell dispatcher", async () => {
    const zsh = await captureConsole(() => cmdShellenv("zsh"));
    expect(zsh.logs.join("\n")).toBe(zshSnippet());
    expect(zsh.logs.join("\n")).toContain("claude46()");
    expect(zsh.logs.join("\n")).toContain("thclaws-cli()");

    const bash = await captureConsole(() => cmdShellenv("bash"));
    expect(bash.logs.join("\n")).toContain("# maw shellenv (bash)");
    expect(bash.logs.join("\n")).toContain("complete -F");
    expect(bash.logs.join("\n")).not.toContain("claude46()");
  });

  test("zsh snippet preserves warp safety checks and command passthrough contracts", () => {
    const snippet = zshSnippet();

    expect(snippet).toContain('if [[ "$1" == "warp" ]]');
    expect(snippet).toContain('local target="${1:-mawjs}"');
    expect(snippet).toContain('qualified <oracle>:<node> not supported yet');
    expect(snippet).toContain('path="$(command maw locate "$target" --path 2>/dev/null)"');
    expect(snippet).toContain('builtin cd "$path"');
    expect(snippet).toContain('command maw "$@"');
    expect(snippet).toContain('command claude "${@/--continue/}"');
    expect(snippet).toContain('ANTHROPIC_MODEL="claude-opus-4-7" claude "$@"');
  });
});

describe("token list implementation and formatter coverage", () => {
  test("detects the active token, lists vault entries, and marks the active token", () => {
    const cwd = mkdtempSync(join(TMP_ROOT, "active-token-"));
    writeFileSync(join(cwd, ".envrc"), 'export CLAUDE_TOKEN_NAME="beta"\n');
    const passCalls: string[][] = [];
    setRunOverride((cmd) => {
      passCalls.push(cmd);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return runResult(true, ["Password Store", "├── token-alpha", "└── token-beta"].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "envrc") {
        return runResult(true, ["Password Store", "envrc/", "  saved-one", "  saved-two"].join("\n"));
      }
      return runResult(false, "", "unexpected", 1);
    });

    const result = cmdList(cwd);
    expect(result).toEqual({
      ok: true,
      cwd,
      active: "beta",
      envrcPresent: true,
      tokens: ["alpha", "beta"],
      envrcs: ["saved-one", "saved-two"],
    });
    expect(passCalls).toEqual([
      ["pass", "ls", "claude"],
      ["pass", "ls", "envrc"],
    ]);

    const formatted = formatList(result);
    expect(formatted).toContain(`Here (${cwd.split("/").pop()}): beta`);
    expect(formatted).toContain("Tokens (claude/):");
    expect(formatted).toContain("1. alpha");
    expect(formatted).toContain("2. beta ← active");
    expect(formatted).toContain("Envrcs (envrc/):");
    expect(formatted).toContain("1. saved-one");
  });

  test("falls back to null active when .envrc cannot be read", () => {
    const cwd = mkdtempSync(join(TMP_ROOT, "unreadable-envrc-"));
    mkdirSync(join(cwd, ".envrc"));
    setRunOverride((cmd) => {
      if (cmd[2] === "claude") return runResult(true, "token-main\n");
      if (cmd[2] === "envrc") return runResult(true, "saved\n");
      return runResult(false);
    });

    const result = cmdList(cwd);

    expect(result.envrcPresent).toBe(true);
    expect(result.active).toBeNull();
    expect(formatList(result)).toContain(`Here (${cwd.split("/").pop()}): .envrc present, no CLAUDE_TOKEN_NAME`);
  });

  test("formats no-envrc and empty-vault states including root cwd fallback", () => {
    setRunOverride(() => runResult(false, "", "pass missing", 127));

    const cwd = mkdtempSync(join(TMP_ROOT, "empty-vault-"));
    const result = cmdList(cwd);
    expect(result).toMatchObject({
      cwd,
      active: null,
      envrcPresent: false,
      tokens: [],
      envrcs: [],
    });
    expect(formatList(result)).toContain("no .envrc");
    expect(formatList(result)).toContain("Empty vault. Add tokens: pass insert claude/token-<name>");

    expect(formatList({
      ok: true,
      cwd: "/",
      active: null,
      envrcPresent: false,
      tokens: [],
      envrcs: [],
    })).toContain("Here (/): no .envrc");
  });
});
