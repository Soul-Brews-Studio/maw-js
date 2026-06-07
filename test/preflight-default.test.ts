/**
 * preflight.ts — default-suite coverage through explicit dependencies.
 */
import { describe, expect, test } from "bun:test";
import type { MawConfig } from "../src/config";
import type { SshSession as Session } from "../src/sdk";
import { cmdPreflight, preflightDeps, type PreflightFs } from "../src/commands/shared/preflight";

interface FakeLstat { isSymbolicLink: () => boolean; }
interface HarnessOptions {
  entries?: string[] | Error;
  symlinks?: Record<string, boolean>;
  exists?: Record<string, boolean>;
  unlinkThrows?: Set<string>;
  sessions?: Session[] | Error;
  paneInfos?: Record<string, { command: string; cwd?: string }>;
  config?: Partial<MawConfig>;
  agentCommands?: Set<string>;
}

function makeHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const unlinks: string[] = [];
  const sendTextCalls: Array<{ target: string; text: string }> = [];
  const buildCalls: Array<{ name: string; cwd: string }> = [];
  const nowValues = [1000, 1042];
  const pluginRoot = "/fake/home/.maw/plugins";

  const deps = preflightDeps({
    now: () => nowValues.shift() ?? 1042,
    packageVersion: () => "26.5.17-alpha.1200",
    pluginDir: () => pluginRoot,
    join: (...parts: string[]) => parts.join("/"),
    fs: async () => ({
      readdirSync: () => {
        if (options.entries instanceof Error) throw options.entries;
        return options.entries ?? [];
      },
      lstatSync: (path: string): FakeLstat => {
        const name = path.split("/").pop() ?? path;
        if (name === "throws-lstat") throw new Error("lstat boom");
        return { isSymbolicLink: () => !!options.symlinks?.[name] };
      },
      existsSync: (path: string) => {
        const name = path.split("/").pop() ?? path;
        return options.exists?.[name] ?? true;
      },
      unlinkSync: (path: string) => {
        const name = path.split("/").pop() ?? path;
        if (options.unlinkThrows?.has(name)) throw new Error("unlink boom");
        unlinks.push(path);
      },
    } as PreflightFs),
    listSessions: async () => {
      if (options.sessions instanceof Error) throw options.sessions;
      return options.sessions ?? [];
    },
    getPaneInfos: async (targets: string[]) => {
      expect(Array.isArray(targets)).toBe(true);
      return options.paneInfos ?? {};
    },
    isAgentCommand: (cmd: string) => options.agentCommands?.has(cmd) ?? cmd.includes("claude"),
    buildCommandInDir: (name: string, cwd: string) => {
      buildCalls.push({ name, cwd });
      return `wake ${name} in ${cwd || "<none>"}`;
    },
    loadConfig: () => (options.config ?? {}) as MawConfig,
    tmux: {
      sendText: async (target: string, text: string) => {
        sendTextCalls.push({ target, text });
      },
    },
    log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
  });

  async function run(fix = false) {
    await cmdPreflight({ fix }, deps);
  }

  return { logs, unlinks, sendTextCalls, buildCalls, run };
}

const session = (name: string, windows: Array<{ index: number; name: string }>): Session => ({
  name,
  windows: windows.map((w) => ({ index: w.index, name: w.name, active: false })),
});

const out = (logs: string[]) => logs.join("\n");

describe("preflight dependency factory", () => {
  test("exposes overridable defaults without changing production call shape", () => {
    const loadConfig = () => ({ node: "m5" }) as MawConfig;
    const deps = preflightDeps({ loadConfig });

    expect(deps.loadConfig).toBe(loadConfig);
    expect(typeof deps.now).toBe("function");
    expect(typeof deps.packageVersion).toBe("function");
    expect(typeof deps.pluginDir).toBe("function");
    expect(typeof deps.fs).toBe("function");
    expect(typeof deps.join).toBe("function");
    expect(typeof deps.listSessions).toBe("function");
    expect(typeof deps.getPaneInfos).toBe("function");
    expect(typeof deps.isAgentCommand).toBe("function");
    expect(typeof deps.buildCommandInDir).toBe("function");
    expect(typeof deps.tmux.sendText).toBe("function");
    expect(typeof deps.log).toBe("function");
  });

  test("default path and filesystem helpers remain lazy and callable", async () => {
    const deps = preflightDeps();
    const oldLog = console.log;
    let logged = "";

    try {
      console.log = ((...args: unknown[]) => { logged = args.map(String).join(" "); }) as typeof console.log;

      expect(deps.now()).toBeGreaterThan(0);
      expect(deps.packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
      expect(deps.pluginDir()).toContain(".maw/plugins");
      expect(typeof (await deps.fs()).readdirSync).toBe("function");
      expect(deps.join("tmp", "maw")).toBe("tmp/maw");
      deps.log("preflight", "default", "log");
    } finally {
      console.log = oldLog;
    }

    expect(logged).toBe("preflight default log");
  });
});

describe("cmdPreflight", () => {
  test("happy path reports version, plugin count, alive sessions, config engines, and pass summary", async () => {
    const h = makeHarness({
      entries: ["one", "two"],
      symlinks: { one: true, two: false },
      exists: { one: true, two: true },
      sessions: [session("54-mawjs", [{ index: 0, name: "mawjs-oracle" }])],
      paneInfos: { "54-mawjs:0": { command: "claude", cwd: "/repo" } },
      config: { node: "m5", commands: { default: "claude", codex: "codex" } },
    });

    await h.run();

    const text = out(h.logs);
    expect(text).toContain("maw preflight");
    expect(text).toContain("version: v26.5.17-alpha.1200");
    expect(text).toContain("plugins: 2 loaded, 0 broken");
    expect(text).toContain("sessions: 1 (1 agents alive)");
    expect(text).toContain("config: node=m5, engines=[codex]");
    expect(text).toContain("4 pass, 0 fail");
  });

  test("missing plugin directory and no sessions produce fail-soft summary", async () => {
    const h = makeHarness({
      entries: new Error("missing"),
      sessions: [],
      config: { commands: { default: "claude" } },
    });

    await h.run();

    const text = out(h.logs);
    expect(text).toContain("plugins: dir missing");
    expect(text).toContain("sessions: none running");
    expect(text).toContain("config: node=?, engines=[default only]");
    expect(text).toContain("2 pass, 1 fail");
  });

  test("broken plugin symlinks fail without --fix and lstat errors are ignored", async () => {
    const h = makeHarness({
      entries: ["broken", "throws-lstat"],
      symlinks: { broken: true },
      exists: { broken: false },
      config: {},
    });

    await h.run(false);

    const text = out(h.logs);
    expect(text).toContain("plugins: 2 loaded, 1 broken symlinks");
    expect(h.unlinks).toEqual([]);
    expect(text).toContain("2 pass, 1 fail");
  });

  test("--fix removes broken plugin symlinks and counts unlink successes", async () => {
    const h = makeHarness({
      entries: ["broken", "also-broken"],
      symlinks: { broken: true, "also-broken": true },
      exists: { broken: false, "also-broken": false },
      unlinkThrows: new Set(["also-broken"]),
      config: {},
    });

    await h.run(true);

    const text = out(h.logs);
    expect(text).toContain("broken symlinks fixed");
    expect(h.unlinks).toEqual(["/fake/home/.maw/plugins/broken"]);
    expect(text).toContain("1 fixed");
  });

  test("dead agents are listed and non-fix mode prints revive hint", async () => {
    const h = makeHarness({
      entries: [],
      sessions: [session("54-mawjs", [
        { index: 0, name: "mawjs-oracle" },
        { index: 1, name: "helper" },
      ])],
      paneInfos: {
        "54-mawjs:0": { command: "claude", cwd: "/repo" },
        "54-mawjs:1": { command: "zsh", cwd: "/repo" },
      },
      config: {},
    });

    await h.run(false);

    const text = out(h.logs);
    expect(text).toContain("sessions: 1 (1 agents alive)");
    expect(text).toContain("dead agents: 1 pane with no agent");
    expect(text).toContain("54-mawjs:helper");
    expect(text).toContain("maw preflight --fix");
    expect(h.sendTextCalls).toEqual([]);
  });

  test("--fix revives dead agents with built commands and counts fixed panes", async () => {
    const h = makeHarness({
      entries: [],
      sessions: [session("54-mawjs", [
        { index: 0, name: "dead-a" },
        { index: 1, name: "dead-b" },
      ])],
      paneInfos: {
        "54-mawjs:0": { command: "zsh", cwd: "/repo/a" },
        "54-mawjs:1": { command: "bash" },
      },
      config: {},
      agentCommands: new Set(["claude"]),
    });

    await h.run(true);

    expect(h.buildCalls).toEqual([
      { name: "dead-a", cwd: "/repo/a" },
      { name: "dead-b", cwd: "" },
    ]);
    expect(h.sendTextCalls).toEqual([
      { target: "54-mawjs:0", text: "wake dead-a in /repo/a" },
      { target: "54-mawjs:1", text: "wake dead-b in <none>" },
    ]);
    expect(out(h.logs)).toContain("2 fixed");
  });

  test("session listing errors are treated as no running sessions", async () => {
    const h = makeHarness({
      entries: [],
      sessions: new Error("tmux down"),
      config: {},
    });

    await h.run();

    expect(out(h.logs)).toContain("sessions: none running");
  });
});
