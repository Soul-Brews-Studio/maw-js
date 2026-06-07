import { describe, expect, test } from "bun:test";
import { UserError } from "../src/core/util/user-error";
import { createDefaultRouteToolsDeps, hasHelpFlag, routeTools, routeToolsWithDeps, type RouteToolsDeps } from "../src/cli/route-tools";

function parseFlags(args: string[], spec: Record<string, unknown>, skip = 0): any {
  const out: any = { _: [] as string[] };
  const argv = args.slice(skip);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const kind = spec[arg];
    if (kind === Boolean) out[arg] = true;
    else if (kind === String) out[arg] = argv[++i];
    else out._.push(arg);
  }
  return out;
}

type HarnessOptions = {
  lifecycleExists?: "dev" | "home" | "none";
  lifecycleManifest?: any;
  lifecycleResult?: { ok: boolean; output?: string; error?: string; exitCode?: number };
  tmuxResult?: { ok: boolean; output?: string; error?: string; exitCode?: number };
};

function harness(options: HarnessOptions = {}) {
  const calls = {
    logs: [] as string[],
    errors: [] as string[],
    stdout: [] as string[],
    exits: [] as number[],
    plugins: [] as any[],
    manifests: [] as string[],
    invokes: [] as any[],
    creates: [] as any[],
    artifacts: [] as any[],
    agents: [] as any[],
    audits: [] as any[],
    tmux: [] as any[],
    status: 0,
    stop: 0,
    locks: [] as any[],
    servers: [] as number[],
    exists: [] as string[],
  };

  const deps: RouteToolsDeps = {
    log: (...a) => calls.logs.push(a.map(String).join(" ")),
    error: (...a) => calls.errors.push(a.map(String).join(" ")),
    stdoutWrite: (chunk) => { calls.stdout.push(chunk); },
    exit: (code = 0) => {
      calls.exits.push(code);
      throw new Error(`exit:${code}`);
    },
    paths: {
      sourceDir: "/src/cli",
      resolve: (...parts) => parts.join("/"),
      join: (...parts) => parts.join("/"),
      homedir: () => "/home/test",
      existsSync: (path) => {
        calls.exists.push(path);
        if (options.lifecycleExists === "dev") return path.includes("commands/plugins/plugin/plugin.json");
        if (options.lifecycleExists === "home") return path.includes(".maw/plugins/plugin/plugin.json");
        return false;
      },
    },
    loadPluginLegacyTools: async () => ({
      parseFlags,
      cmdPlugins: (sub, args, flags) => { calls.plugins.push({ sub, args, flags }); },
    }),
    loadPluginLifecycleTools: async () => ({
      loadManifestFromDir: (dir) => {
        calls.manifests.push(dir);
        return options.lifecycleManifest === undefined ? { manifest: { name: "plugin" } } : options.lifecycleManifest;
      },
      invokePlugin: async (plugin, ctx) => {
        calls.invokes.push({ plugin, ctx });
        return options.lifecycleResult ?? { ok: true, output: "lifecycle ok" };
      },
    }),
    loadPluginCreateTools: async () => ({
      parseFlags,
      cmdPluginCreate: (name, flags) => { calls.creates.push({ name, flags }); },
    }),
    loadArtifactsTools: async () => ({
      parseFlags,
      cmdArtifacts: (sub, args, flags) => { calls.artifacts.push({ sub, args, flags }); },
    }),
    loadAgentsTools: async () => ({
      parseFlags,
      cmdAgents: (opts) => { calls.agents.push(opts); },
    }),
    loadAuditTools: async () => ({
      cmdAudit: (args) => { calls.audits.push(args); },
    }),
    loadTmuxTools: async () => ({
      tmuxHandler: async (ctx) => {
        calls.tmux.push(ctx);
        ctx.writer("tmux", "stream");
        return options.tmuxResult ?? { ok: true };
      },
    }),
    loadServeStatusTools: async () => ({
      printServeStatusWithPlugins: () => { calls.status++; },
      stopServe: () => { calls.stop++; },
    }),
    loadServeStartTools: async () => ({
      acquirePidLock: (instanceName, opts) => { calls.locks.push({ instanceName, opts }); },
      startServer: (port) => { calls.servers.push(port); },
    }),
  };

  return { calls, deps };
}

describe("routeTools default-suite seams", () => {

  test("default dependency loader factory stays wired to production modules", async () => {
    const original = {
      log: console.log,
      error: console.error,
      write: process.stdout.write,
      errWrite: process.stderr.write,
      exit: process.exit,
    };
    const seen = { logs: [] as string[], errors: [] as string[], writes: [] as string[], errWrites: [] as string[], exits: [] as number[] };
    console.log = (...a: unknown[]) => { seen.logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { seen.errors.push(a.map(String).join(" ")); };
    process.stdout.write = ((chunk: unknown) => { seen.writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { seen.errWrites.push(String(chunk)); return true; }) as typeof process.stderr.write;
    (process as any).exit = (code?: number) => {
      seen.exits.push(code ?? 0);
      throw new Error(`default-exit:${code ?? 0}`);
    };

    try {
      const serverStarts: number[] = [];
      const deps = createDefaultRouteToolsDeps(async () => ({
        startServer: (port) => { serverStarts.push(port); },
      }));
      deps.log("hello", "log");
      deps.error("hello", "err");
      deps.stdoutWrite("hello write");
      expect(() => deps.exit(42)).toThrow("default-exit:42");
      expect(seen).toMatchObject({
        logs: ["hello log"],
        errors: ["hello err"],
        writes: ["hello write"],
        exits: [42],
      });

      expect(typeof deps.paths.resolve).toBe("function");
      expect(typeof deps.paths.join).toBe("function");
      expect(typeof deps.paths.existsSync).toBe("function");
      expect(typeof deps.paths.homedir).toBe("function");
      expect(deps.paths.sourceDir).toContain("src/cli");

      expect(typeof (await deps.loadPluginLegacyTools()).cmdPlugins).toBe("function");
      expect(typeof (await deps.loadPluginLifecycleTools()).invokePlugin).toBe("function");
      expect(typeof (await deps.loadPluginCreateTools()).cmdPluginCreate).toBe("function");
      expect(typeof (await deps.loadArtifactsTools()).cmdArtifacts).toBe("function");
      expect(typeof (await deps.loadAgentsTools()).cmdAgents).toBe("function");
      expect(typeof (await deps.loadAuditTools()).cmdAudit).toBe("function");
      expect(typeof (await deps.loadTmuxTools()).tmuxHandler).toBe("function");
      expect(typeof (await deps.loadServeStatusTools()).stopServe).toBe("function");
      const serveStart = await deps.loadServeStartTools();
      expect(typeof serveStart.startServer).toBe("function");
      await serveStart.startServer(6789);
      expect(serverStarts).toEqual([6789]);
    } finally {
      console.log = original.log;
      console.error = original.error;
      process.stdout.write = original.write;
      process.stderr.write = original.errWrite;
      (process as any).exit = original.exit;
    }
  });
  test("help detection short-circuits core routes and misses unknown commands", async () => {
    const h = harness();
    expect(hasHelpFlag(["-h"])).toBe(true);
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["--json"])).toBe(false);

    expect(await routeToolsWithDeps("plugins", ["plugins", "--help"], h.deps)).toBe(true);
    expect(h.calls.logs.join("\n")).toContain("usage: maw plugins");
    expect(h.calls.plugins).toEqual([]);

    expect(await routeTools("definitely-not-a-route", ["definitely-not-a-route"])).toBe(false);
    expect(await routeToolsWithDeps("definitely-not-a-route", ["definitely-not-a-route"], h.deps)).toBe(false);
  });

  test("routes plugins, artifacts, agents, and audit through injected handlers", async () => {
    const h = harness();

    expect(await routeToolsWithDeps("plugins", ["plugins", "info", "about", "--json"], h.deps)).toBe(true);
    expect(h.calls.plugins[0]).toMatchObject({ sub: "info", args: ["about", "--json"], flags: { "--json": true } });

    expect(await routeToolsWithDeps("plugin", ["plugin", "ls", "--all", "-v", "--api"], h.deps)).toBe(true);
    expect(h.calls.plugins[1]).toMatchObject({
      sub: "ls",
      args: ["--all", "-v", "--api"],
      flags: { "--all": true, "-v": true, "--api": true },
    });

    expect(await routeToolsWithDeps("artifact", ["artifact", "get", "team", "task-1", "--json"], h.deps)).toBe(true);
    expect(h.calls.artifacts[0]).toMatchObject({ sub: "get", args: ["team", "task-1", "--json"], flags: { "--json": true } });

    expect(await routeToolsWithDeps("agents", ["agents", "--json", "--all", "--node", "m5"], h.deps)).toBe(true);
    expect(h.calls.agents[0]).toEqual({ json: true, all: true, node: "m5" });

    expect(await routeToolsWithDeps("audit", ["audit", "5"], h.deps)).toBe(true);
    expect(h.calls.audits).toEqual([["5"]]);
  });

  test("plugin lifecycle dispatch uses dev/home candidates, logs output, and fails loudly", async () => {
    const dev = harness({ lifecycleExists: "dev" });
    expect(await routeToolsWithDeps("plugin", ["plugin", "install", "demo"], dev.deps)).toBe(true);
    expect(dev.calls.manifests[0]).toContain("commands/plugins/plugin");
    expect(dev.calls.invokes[0].ctx.args).toEqual(["install", "demo"]);
    expect(dev.calls.logs).toContain("lifecycle ok");

    const home = harness({ lifecycleExists: "home", lifecycleResult: { ok: true } });
    expect(await routeToolsWithDeps("plugin", ["plugin", "search", "demo"], home.deps)).toBe(true);
    expect(home.calls.manifests[0]).toContain(".maw/plugins/plugin");
    expect(home.calls.logs).toEqual([]);

    const failing = harness({ lifecycleExists: "dev", lifecycleResult: { ok: false, error: "install exploded", exitCode: 9 } });
    await expect(routeToolsWithDeps("plugin", ["plugin", "build"], failing.deps)).rejects.toThrow("exit:1");
    expect(failing.calls.errors).toContain("install exploded");
    expect(failing.calls.exits).toEqual([1]);

    const missing = harness({ lifecycleExists: "none" });
    await expect(routeToolsWithDeps("plugin", ["plugin", "install"], missing.deps)).rejects.toThrow("exit:1");
    expect(missing.calls.errors.join("\n")).toContain("usage: maw plugin create");

    const nullManifest = harness({ lifecycleExists: "dev", lifecycleManifest: null });
    await expect(routeToolsWithDeps("plugin", ["plugin", "dev"], nullManifest.deps)).rejects.toThrow("exit:1");
    expect(nullManifest.calls.manifests).toHaveLength(1);
  });

  test("plugin create and invalid plugin subcommands keep the legacy CLI contract", async () => {
    const create = harness();
    expect(await routeToolsWithDeps("plugin", ["plugin", "create", "ledger", "--rust", "--dest", "/tmp/ledger"], create.deps)).toBe(true);
    expect(create.calls.creates[0]).toMatchObject({
      name: "ledger",
      flags: { _: ["ledger"], "--rust": true, "--dest": "/tmp/ledger" },
    });

    const invalid = harness();
    await expect(routeToolsWithDeps("plugin", ["plugin", "wat"], invalid.deps)).rejects.toThrow("exit:1");
    expect(invalid.calls.errors.join("\n")).toContain("usage: maw plugin create");
  });

  test("tmux streams through stdout writer and exits on handler errors", async () => {
    const ok = harness();
    expect(await routeToolsWithDeps("tmux", ["tmux", "peek", "47-mawjs:1.0"], ok.deps)).toBe(true);
    expect(ok.calls.tmux[0].args).toEqual(["peek", "47-mawjs:1.0"]);
    expect(ok.calls.stdout.join("")).toContain("tmux stream");

    const fail = harness({ tmuxResult: { ok: false, error: "tmux failed", exitCode: 7 } });
    await expect(routeToolsWithDeps("tmux", ["tmux", "send", "pane", "cmd"], fail.deps)).rejects.toThrow("exit:7");
    expect(fail.calls.errors).toContain("tmux failed");
    expect(fail.calls.exits).toEqual([7]);
  });

  test("serve status/stop/start/default-port and unknown-flag paths stay side-effect bounded", async () => {
    const status = harness();
    expect(await routeToolsWithDeps("serve", ["serve", "--status"], status.deps)).toBe(true);
    expect(status.calls.status).toBe(1);
    expect(status.calls.servers).toEqual([]);

    const stop = harness();
    expect(await routeToolsWithDeps("serve", ["serve", "stop"], stop.deps)).toBe(true);
    expect(stop.calls.stop).toBe(1);

    const start = harness();
    expect(await routeToolsWithDeps("serve", ["serve", "4567", "--as", "blue", "--force-takeover"], start.deps)).toBe(true);
    expect(start.calls.locks).toEqual([{ instanceName: "blue", opts: { forceTakeover: true } }]);
    expect(start.calls.servers).toEqual([4567]);

    const defaultPort = harness();
    expect(await routeToolsWithDeps("serve", ["serve"], defaultPort.deps)).toBe(true);
    expect(defaultPort.calls.locks).toEqual([{ instanceName: null, opts: { forceTakeover: false } }]);
    expect(defaultPort.calls.servers).toEqual([3456]);

    const bad = harness();
    await expect(routeToolsWithDeps("serve", ["serve", "--as", "blue", "--force-takeover", "--bogus"], bad.deps)).rejects.toBeInstanceOf(UserError);
    expect(bad.calls.errors.join("\n")).toContain("unknown flag '--bogus'");
    expect(bad.calls.locks).toEqual([]);
    expect(bad.calls.servers).toEqual([]);
  });
});
