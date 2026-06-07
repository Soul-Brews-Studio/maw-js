import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const sessionsRef: Array<{ name: string; windows: Array<{ index: number; name?: string }> }> = [];
const tmuxInstances: FakeTmux[] = [];
const attachRemoteCalls: unknown[] = [];
const anomalyCalls: unknown[] = [];
const execFileCalls: unknown[] = [];
const defaultWakeCalls: unknown[] = [];
let configHost: string | undefined = "local";
let socketValue: string | undefined;
let nextHasSession = false;
let fleetSession: unknown = null;
let autoWakeDecision: { wake: boolean; reason?: string } = { wake: false, reason: "test" };
let resolveImpl: (agent: string, sessions: unknown[]) => unknown = (agent, sessions) => {
  const match = (sessions as Array<{ name: string }>).find((s) => s.name === agent);
  return match ? { kind: "exact", match } : { kind: "none", hints: [] };
};

class FakeTmux {
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor() {
    tmuxInstances.push(this);
  }

  async hasSession(name: string): Promise<boolean> {
    this.calls.push({ method: "hasSession", args: [name] });
    return nextHasSession;
  }

  async newGroupedSession(parent: string, view: string, opts?: unknown): Promise<void> {
    this.calls.push({ method: "newGroupedSession", args: [parent, view, opts] });
  }

  async selectWindow(target: string): Promise<void> {
    this.calls.push({ method: "selectWindow", args: [target] });
  }

  async set(target: string, option: string, value: string): Promise<void> {
    this.calls.push({ method: "set", args: [target, option, value] });
  }

  async switchClient(target: string, opts?: unknown): Promise<void> {
    this.calls.push({ method: "switchClient", args: opts === undefined ? [target] : [target, opts] });
  }

  async killSession(target: string): Promise<void> {
    this.calls.push({ method: "killSession", args: [target] });
  }
}

mock.module("child_process", () => ({
  execFileSync: (...args: unknown[]) => {
    execFileCalls.push(args);
    return "";
  },
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessionsRef,
  Tmux: FakeTmux,
  resolveSocket: () => socketValue,
  attachRemoteSession: (opts: unknown) => {
    attachRemoteCalls.push(opts);
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ host: configHost }),
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (agent: string, sessions: unknown[]) => resolveImpl(agent, sessions),
}));

mock.module("maw-js/core/fleet/audit", () => ({
  logAnomaly: (...args: unknown[]) => {
    anomalyCalls.push(args);
  },
}));

mock.module("maw-js/commands/shared/wake-resolve", () => ({
  resolveFleetSession: () => fleetSession,
}));

mock.module("maw-js/commands/shared/should-auto-wake", () => ({
  shouldAutoWake: () => autoWakeDecision,
}));

mock.module("maw-js/commands/shared/wake-cmd", () => ({
  cmdWake: async (target: string, opts: unknown) => {
    defaultWakeCalls.push({ target, opts });
  },
}));

const { cmdView, decideWakePrompt } = await import("../../src/vendor/mpr-plugins/view/impl");

const original = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  tmux: process.env.TMUX,
  mawHost: process.env.MAW_HOST,
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
};

let logs: string[] = [];
let errors: string[] = [];
let warns: string[] = [];

function captureConsole() {
  logs = [];
  errors = [];
  warns = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
}

function restoreGlobals() {
  console.log = original.log;
  console.error = original.error;
  console.warn = original.warn;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  if (original.mawHost === undefined) delete process.env.MAW_HOST;
  else process.env.MAW_HOST = original.mawHost;
  if (original.stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", original.stdinIsTTY);
}

beforeEach(() => {
  sessionsRef.length = 0;
  tmuxInstances.length = 0;
  attachRemoteCalls.length = 0;
  anomalyCalls.length = 0;
  execFileCalls.length = 0;
  defaultWakeCalls.length = 0;
  nextHasSession = false;
  fleetSession = null;
  autoWakeDecision = { wake: false, reason: "test" };
  configHost = "local";
  socketValue = undefined;
  delete process.env.MAW_HOST;
  process.env.TMUX = "/tmp/test-tmux,1,0";
  resolveImpl = (agent, sessions) => {
    const match = (sessions as Array<{ name: string }>).find((s) => s.name === agent);
    return match ? { kind: "exact", match } : { kind: "none", hints: [] };
  };
  captureConsole();
});

afterEach(() => {
  restoreGlobals();
});

describe("view impl coverage", () => {
  test("decideWakePrompt prefers explicit skip/force before TTY prompting", () => {
    expect(decideWakePrompt({ isTTY: true, noWake: true, wake: true })).toBe("skip");
    expect(decideWakePrompt({ isTTY: false, wake: true })).toBe("force");
    expect(decideWakePrompt({ isTTY: false })).toBe("skip");
    expect(decideWakePrompt({ isTTY: true })).toBe("ask");
  });



  test("reports ambiguous session matches with exact candidate names", async () => {
    const candidates = [
      { name: "101-mawjs", windows: [{ index: 0, name: "shell" }] },
      { name: "102-maw-m5", windows: [{ index: 0, name: "shell" }] },
    ];
    sessionsRef.push(...candidates);
    resolveImpl = () => ({ kind: "ambiguous", candidates });

    await expect(cmdView("maw")).rejects.toThrow("'maw' is ambiguous — matches 2 sessions");

    expect(errors.join("\n")).toContain("matches 2 sessions");
    expect(errors.join("\n")).toContain("101-mawjs");
    expect(errors.join("\n")).toContain("use the full name: maw view <exact-session>");
    expect(tmuxInstances).toHaveLength(0);
  });

  test("creates a grouped view, selects the requested window, cleans it, and switches inside tmux", async () => {
    sessionsRef.push({
      name: "101-mawjs",
      windows: [{ index: 0, name: "shell" }, { index: 1, name: "logs" }],
    });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs", { windowHint: "log", clean: true });

    expect(tmuxInstances).toHaveLength(1);
    expect(tmuxInstances[0].calls).toContainEqual({
      method: "hasSession",
      args: ["mawjs-view-log"],
    });
    expect(tmuxInstances[0].calls).toContainEqual({
      method: "newGroupedSession",
      args: ["101-mawjs", "mawjs-view-log", { windowSize: "largest" }],
    });
    expect(tmuxInstances[0].calls).toContainEqual({ method: "selectWindow", args: ["mawjs-view-log:1"] });
    expect(tmuxInstances[0].calls).toContainEqual({ method: "set", args: ["mawjs-view-log", "status", "off"] });
    expect(tmuxInstances[0].calls).toContainEqual({ method: "switchClient", args: ["mawjs-view-log"] });
    expect(logs.join("\n")).toContain("created");
    expect(logs.join("\n")).toContain("window");
  });

  test("reuses an existing grouped view, attaches remotely, and honors kill cleanup", async () => {
    delete process.env.TMUX;
    configHost = "whitebox";
    nextHasSession = true;
    sessionsRef.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs", undefined, false, true);

    expect(tmuxInstances[0].calls).toContainEqual({ method: "hasSession", args: ["mawjs-view"] });
    expect(tmuxInstances[0].calls.some((call) => call.method === "newGroupedSession")).toBe(false);
    expect(attachRemoteCalls).toEqual([{ node: "whitebox", sshAlias: "whitebox", sessionName: "mawjs-view" }]);
    expect(tmuxInstances[0].calls).toContainEqual({ method: "killSession", args: ["mawjs-view"] });
    expect(logs.join("\n")).toContain("reuse");
  });

  test("attaches directly to an existing view session and logs the reattach reflex", async () => {
    sessionsRef.push({ name: "mawjs-view", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs-view", { windowHint: "missing", clean: true });

    expect(anomalyCalls).toHaveLength(1);
    expect(warns.join("\n")).toContain("attaching to existing view");
    expect(errors.join("\n")).toContain("window 'missing' not found");
    expect(tmuxInstances[0].calls).toContainEqual({ method: "set", args: ["mawjs-view", "status", "off"] });
    expect(tmuxInstances[0].calls).toContainEqual({ method: "switchClient", args: ["mawjs-view"] });
    expect(tmuxInstances[0].calls.some((call) => call.method === "hasSession")).toBe(false);
  });



  test("selects a requested window before attaching directly to an existing view", async () => {
    sessionsRef.push({ name: "mawjs-view", windows: [{ index: 0, name: "shell" }, { index: 3, name: "logs" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs", { windowHint: "logs" });

    expect(tmuxInstances[0].calls).toContainEqual({ method: "selectWindow", args: ["mawjs-view:3"] });
    expect(logs.join("\n")).toContain("logs (3)");
    expect(tmuxInstances[0].calls).toContainEqual({ method: "switchClient", args: ["mawjs-view"] });
  });

  test("falls back to matching a window name when session resolution misses", async () => {
    sessionsRef.push({ name: "worker-host", windows: [{ index: 0, name: "main" }, { index: 2, name: "codex-logs" }] });
    resolveImpl = () => ({ kind: "none", hints: [] });

    await cmdView("logs");

    expect(tmuxInstances[0].calls).toContainEqual({ method: "newGroupedSession", args: ["worker-host", "worker-host-view", { windowSize: "largest" }] });
    expect(tmuxInstances[0].calls).toContainEqual({ method: "switchClient", args: ["worker-host-view"] });
  });



  test("uses local tmux attach-session argv when outside tmux on a local host", async () => {
    delete process.env.TMUX;
    socketValue = "/tmp/maw.sock";
    sessionsRef.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs");

    expect(execFileCalls).toEqual([[
      "tmux",
      ["-S", "/tmp/maw.sock", "attach-session", "-t", "mawjs-view"],
      { stdio: "inherit" },
    ]]);
  });

  test("attaches read-only inside tmux and outside tmux", async () => {
    sessionsRef.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs", { readonly: true });

    expect(tmuxInstances[0].calls).toContainEqual({
      method: "switchClient",
      args: ["mawjs-view", { readonly: true }],
    });
    expect(logs.join("\n")).toContain("read-only");

    delete process.env.TMUX;
    tmuxInstances.length = 0;
    execFileCalls.length = 0;

    await cmdView("mawjs", { readonly: true });

    expect(execFileCalls).toEqual([[
      "tmux",
      ["attach-session", "-r", "-t", "mawjs-view"],
      { stdio: "inherit" },
    ]]);
  });

  test("rejects read-only split and remote read-only until those paths can enforce it", async () => {
    await expect(cmdView("mawjs", { readonly: true, splitAnchor: true }))
      .rejects.toThrow("--readonly cannot be combined with --split");

    delete process.env.TMUX;
    configHost = "whitebox";
    sessionsRef.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await expect(cmdView("mawjs", { readonly: true }))
      .rejects.toThrow("remote readonly attach needs attach-ssh support");
    expect(attachRemoteCalls).toEqual([]);
  });

  test("force-wakes a missing target without prompting", async () => {
    const wakeCalls: string[] = [];
    resolveImpl = () => ({ kind: "none", hints: [] });

    await cmdView("sleepy", { wake: true, wakeImpl: async (target) => { wakeCalls.push(target); } });

    expect(wakeCalls).toEqual(["sleepy"]);
    expect(logs.join("\n")).toContain("waking 'sleepy'");
    expect(tmuxInstances).toHaveLength(0);
  });



  test("prompts on TTY and wakes when the user answers yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const wakeCalls: string[] = [];
    resolveImpl = () => ({ kind: "none", hints: [] });

    await cmdView("sleepy", {
      ask: async (question) => {
        expect(question).toContain("Wake it now?");
        return "yes";
      },
      wakeImpl: async (target) => { wakeCalls.push(target); },
    });

    expect(wakeCalls).toEqual(["sleepy"]);
  });

  test("auto-wakes fleet-known missing targets with the default wake implementation", async () => {
    fleetSession = { name: "fleet-sleepy" };
    autoWakeDecision = { wake: true, reason: "fleet-known" };
    resolveImpl = () => ({ kind: "none", hints: [] });

    await cmdView("sleepy");

    expect(defaultWakeCalls).toEqual([{ target: "sleepy", opts: { attach: true } }]);
    expect(logs.join("\n")).toContain("fleet-known");
    expect(logs.join("\n")).toContain("waking 'sleepy'");
  });



  test("declining a TTY wake prompt falls through to the not-found guidance", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    resolveImpl = () => ({ kind: "none", hints: [] });

    await expect(cmdView("sleepy", { ask: async () => "no" })).rejects.toThrow("session not found for: sleepy");

    expect(defaultWakeCalls).toEqual([]);
    expect(errors.join("\n")).toContain("try: maw ls");
  });

  test("unavailable TTY prompts fall through to the existing not-found error", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    resolveImpl = () => ({ kind: "none", hints: [] });

    await expect(cmdView("sleepy", { ask: async () => { throw new Error("no tty"); } })).rejects.toThrow("session not found for: sleepy");

    expect(defaultWakeCalls).toEqual([]);
  });

  test("grouped views warn when a requested window hint misses", async () => {
    sessionsRef.push({ name: "101-mawjs", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });

    await cmdView("mawjs", { windowHint: "logs" });

    expect(errors.join("\n")).toContain("window 'logs' not found");
    expect(tmuxInstances[0].calls).toContainEqual({ method: "switchClient", args: ["mawjs-view-logs"] });
  });

  test("existing view attach failures are logged without throwing outside tmux", async () => {
    delete process.env.TMUX;
    execFileCalls.length = 0;
    sessionsRef.push({ name: "mawjs-view", windows: [{ index: 0, name: "shell" }] });
    resolveImpl = () => ({ kind: "exact", match: sessionsRef[0] });
    const previousExec = execFileCalls.push.bind(execFileCalls);
    execFileCalls.push = ((...items: unknown[]) => {
      previousExec(...items);
      throw new Error("recording push failed");
    }) as typeof execFileCalls.push;
    try {
      await cmdView("mawjs-view");
    } finally {
      execFileCalls.push = previousExec as typeof execFileCalls.push;
    }

    expect(errors.join("\n")).toContain("attach exited non-zero");
  });

  test("prints resolver hints and maw ls guidance when a missing target is not woken", async () => {
    resolveImpl = () => ({ kind: "none", hints: [{ name: "mawjs" }, { name: "maw-m5" }] });

    await expect(cmdView("ma", { noWake: true })).rejects.toThrow("session not found for: ma");

    expect(errors.join("\n")).toContain("did you mean");
    expect(errors.join("\n")).toContain("mawjs");
    expect(errors.join("\n")).toContain("try: maw ls");
  });
});
