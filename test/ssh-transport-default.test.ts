/**
 * ssh.ts — default-suite coverage for host execution and high-level tmux
 * forwarding without spawning real local shells, ssh, or tmux clients.
 */
import { describe, expect, test } from "bun:test";
import { createSshTransport, HostExecError, sshDeps, type SshDeps } from "../src/core/transport/ssh";

const body = (text: string) => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  },
});

type TmuxCall = [string, ...unknown[]];

function makeHarness(options: {
  host?: string;
  env?: NodeJS.ProcessEnv;
  spawnResults?: Array<{ stdout?: string; stderr?: string; code?: number }>;
  commands?: Record<string, string>;
  requireThrows?: boolean;
} = {}) {
  const spawnResults = [...(options.spawnResults ?? [])];
  const spawnCalls: Array<{ args: string[]; opts: unknown }> = [];
  const tmuxHosts: Array<string | undefined> = [];
  const tmuxCalls: TmuxCall[] = [];
  const tmux = {
    listSessions: async () => {
      tmuxCalls.push(["listSessions"]);
      return [{ name: "s", windows: [{ index: 1, name: "w", active: true }] }];
    },
    capture: async (target: string, lines = 80) => {
      tmuxCalls.push(["capture", target, lines]);
      return `capture:${target}:${lines}`;
    },
    selectWindow: async (target: string) => { tmuxCalls.push(["selectWindow", target]); },
    getPaneCommand: async (target: string) => {
      tmuxCalls.push(["getPaneCommand", target]);
      return `cmd:${target}`;
    },
    getPaneCommands: async (targets: string[]) => {
      tmuxCalls.push(["getPaneCommands", targets]);
      return Object.fromEntries(targets.map((target) => [target, `cmd:${target}`]));
    },
    getPaneInfos: async (targets: string[]) => {
      tmuxCalls.push(["getPaneInfos", targets]);
      return Object.fromEntries(targets.map((target) => [target, { command: `cmd:${target}`, cwd: `/cwd/${target}` }]));
    },
    exitModeIfNeeded: async (target: string) => {
      tmuxCalls.push(["exitModeIfNeeded", target]);
      return true;
    },
    sendKeys: async (target: string, ...keys: string[]) => { tmuxCalls.push(["sendKeys", target, ...keys]); },
    sendKeysLiteral: async (target: string, text: string) => { tmuxCalls.push(["sendKeysLiteral", target, text]); },
    sendText: async (target: string, text: string) => { tmuxCalls.push(["sendText", target, text]); },
  };

  const deps: Partial<SshDeps> = {
    loadConfig: () => ({ host: options.host ?? "local" } as any),
    env: () => options.env ?? {},
    tmuxCmd: () => "tmux-mock",
    spawn: (args: string[], opts: unknown) => {
      spawnCalls.push({ args, opts });
      const result = spawnResults.shift() ?? { stdout: " ok \n", code: 0 };
      return {
        stdout: body(result.stdout ?? ""),
        stderr: body(result.stderr ?? ""),
        exited: Promise.resolve(result.code ?? 0),
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
    createTmux: (host?: string) => {
      tmuxHosts.push(host);
      return tmux as any;
    },
    requireConfig: () => {
      if (options.requireThrows) throw new Error("missing config");
      return { loadConfig: () => ({ commands: options.commands ?? {} }) as any };
    },
  };

  return {
    transport: createSshTransport(deps),
    spawnCalls,
    tmuxHosts,
    tmuxCalls,
  };
}

describe("sshDeps", () => {
  test("exposes overridable defaults", () => {
    const spawn = (() => { throw new Error("unused"); }) as unknown as typeof Bun.spawn;
    const deps = sshDeps({ spawn });

    expect(deps.spawn).toBe(spawn);
    expect(typeof deps.createTmux).toBe("function");
    expect(typeof deps.tmuxCmd).toBe("function");
    expect(typeof deps.loadConfig).toBe("function");
    expect(typeof deps.env()).toBe("object");
    expect(typeof deps.requireConfig).toBe("function");
  });
});

describe("createSshTransport", () => {
  test("hostExec runs local commands by default, trims stdout, and exposes ssh alias", async () => {
    const h = makeHarness({ spawnResults: [{ stdout: "  hello\n", code: 0 }, { stdout: "alias\n", code: 0 }] });

    await expect(h.transport.hostExec("echo hello")).resolves.toBe("hello");
    await expect(h.transport.ssh("echo alias")).resolves.toBe("alias");

    expect(h.spawnCalls[0]).toMatchObject({
      args: ["bash", "-c", "echo hello"],
      opts: { stdout: "pipe", stderr: "pipe", windowsHide: true },
    });
  });

  test("hostExec uses ssh for explicit remote hosts and reports stderr with metadata", async () => {
    const h = makeHarness({ host: "hub.example", spawnResults: [{ stderr: "remote failed\n", code: 7 }] });

    try {
      await h.transport.hostExec("uptime", "remote.example");
      throw new Error("expected hostExec to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HostExecError);
      const err = error as HostExecError;
      expect(err.message).toBe("[ssh:remote.example] remote failed");
      expect(err.target).toBe("remote.example");
      expect(err.transport).toBe("ssh");
      expect(err.exitCode).toBe(7);
      expect(err.underlying.message).toBe("remote failed");
    }

    expect(h.spawnCalls[0].args).toEqual(["ssh", "remote.example", "uptime"]);
  });

  test("hostExec falls back to exit-code text when stderr is empty", async () => {
    const h = makeHarness({ spawnResults: [{ code: 42 }] });

    await expect(h.transport.hostExec("nope", "local")).rejects.toThrow("[local:local] exit 42");
  });

  test("config local host keeps explicit remote-looking host on the local transport", async () => {
    const h = makeHarness({ host: "localhost", spawnResults: [{ stdout: "local\n", code: 0 }] });

    await expect(h.transport.hostExec("pwd", "other-host")).resolves.toBe("local");

    expect(h.spawnCalls[0].args).toEqual(["bash", "-c", "pwd"]);
  });

  test("tmux wrappers construct per-call clients with the requested host", async () => {
    const h = makeHarness();

    await expect(h.transport.listSessions("h1")).resolves.toEqual([{ name: "s", windows: [{ index: 1, name: "w", active: true }] }]);
    await expect(h.transport.capture("s:1", 12, "h2")).resolves.toBe("capture:s:1:12");
    await h.transport.selectWindow("s:2", "h3");
    await expect(h.transport.getPaneCommand("s:3", "h4")).resolves.toBe("cmd:s:3");
    await expect(h.transport.getPaneCommands(["a", "b"], "h5")).resolves.toEqual({ a: "cmd:a", b: "cmd:b" });
    await expect(h.transport.getPaneInfos(["a"], "h6")).resolves.toEqual({ a: { command: "cmd:a", cwd: "/cwd/a" } });

    expect(h.tmuxHosts).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    expect(h.tmuxCalls).toEqual([
      ["listSessions"],
      ["capture", "s:1", 12],
      ["selectWindow", "s:2"],
      ["getPaneCommand", "s:3"],
      ["getPaneCommands", ["a", "b"]],
      ["getPaneInfos", ["a"]],
    ]);
  });

  test("switchClient is gated on TMUX and swallows switch failures", async () => {
    const outside = makeHarness({ env: {}, spawnResults: [{ code: 0 }] });
    await outside.transport.switchClient("s", "remote");
    expect(outside.spawnCalls).toEqual([]);

    const inside = makeHarness({ host: "hub.example", env: { TMUX: "/tmp/tmux" } as NodeJS.ProcessEnv, spawnResults: [{ stderr: "no client", code: 1 }] });
    await inside.transport.switchClient("session's", "remote");
    expect(inside.spawnCalls[0].args).toEqual([
      "ssh",
      "remote",
      "tmux-mock switch-client -t 'session's' 2>/dev/null",
    ]);
  });

  test("isAgentCommand matches configured binaries and tolerates config loading failure", () => {
    const h = makeHarness({ commands: { opus: "opencode --model x", skip: "default" } });

    expect(h.transport.isAgentCommand("opencode")).toBe(true);
    expect(h.transport.isAgentCommand("default")).toBe(false);
    expect(h.transport.isAgentCommand("claude-code")).toBe(true);
    expect(h.transport.isAgentCommand("codex")).toBe(true);
    expect(h.transport.isAgentCommand("node")).toBe(true);
    expect(h.transport.isAgentCommand("nodemon")).toBe(false);
    expect(h.transport.isAgentCommand("2.1.121")).toBe(true);
    expect(h.transport.isAgentCommand("  ")).toBe(false);

    expect(makeHarness({ requireThrows: true }).transport.isAgentCommand("opencode")).toBe(false);
  });

  test("sendKeys maps special keys, handles enter-only input, slash commands, and smart text", async () => {
    const h = makeHarness();

    await h.transport.sendKeys("pane", "\x1b");
    await h.transport.sendKeys("pane", "\x1b[A");
    await h.transport.sendKeys("pane", "\r");
    await h.transport.sendKeys("pane", "\n");
    await h.transport.sendKeys("pane", "\b");
    await h.transport.sendKeys("pane", "\x15");
    await h.transport.sendKeys("pane", "/compact\n");
    await h.transport.sendKeys("pane", "hello\n");

    expect(h.tmuxCalls).toEqual([
      ["sendKeys", "pane", "Escape"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeys", "pane", "Up"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeys", "pane", "Enter"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeys", "pane", "Enter"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeys", "pane", "BSpace"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeys", "pane", "C-u"],
      ["exitModeIfNeeded", "pane"],
      ["sendKeysLiteral", "pane", "/"],
      ["sendKeysLiteral", "pane", "c"],
      ["sendKeysLiteral", "pane", "o"],
      ["sendKeysLiteral", "pane", "m"],
      ["sendKeysLiteral", "pane", "p"],
      ["sendKeysLiteral", "pane", "a"],
      ["sendKeysLiteral", "pane", "c"],
      ["sendKeysLiteral", "pane", "t"],
      ["sendKeys", "pane", "Enter"],
      ["sendText", "pane", "hello"],
    ]);
  });
});
