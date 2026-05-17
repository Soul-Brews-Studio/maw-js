import { existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { UserError } from "../core/util/user-error";

// #388.1 — core-route usage strings for --help intercept. These routes don't
// pass through invokePlugin, so they need their own --help guard to prevent
// `maw plugin list --help` / `maw agents --help` from running real work.
const CORE_HELP: Record<string, string> = {
  plugins: "usage: maw plugins [ls|info <name>|remove <name>|lean|standard|full|nuke|enable <name...>|disable <name>] [--json] [--all] [--force]",
  plugin: "usage: maw plugin <init|build|install|create|ls|info|remove|enable <name...>|disable> [args]",
  artifacts: "usage: maw artifacts [ls|get] [team] [task-id] [--json]",
  artifact: "usage: maw artifact [ls|get] [team] [task-id] [--json]",
  agents: "usage: maw agents [--json] [--all] [--node <node>]",
  agent: "usage: maw agent [--json] [--all] [--node <node>]",
  audit: "usage: maw audit [limit]",
  serve: "usage: maw serve [port] [--as <name>] [--force-takeover] | maw serve status|--status|stop",
};

type ParseFlags = (args: string[], spec: Record<string, unknown>, skip?: number) => any;
type InvokeResult = { ok: boolean; output?: string; error?: string; exitCode?: number };

type PluginLegacyTools = {
  cmdPlugins: (sub: string, args: string[], flags: any) => Promise<void> | void;
  parseFlags: ParseFlags;
};

type PluginLifecycleTools = {
  loadManifestFromDir: (dir: string) => any;
  invokePlugin: (plugin: any, ctx: { source: "cli"; args: string[] }) => Promise<InvokeResult> | InvokeResult;
};

type PathTools = {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
  existsSync: (path: string) => boolean;
  homedir: () => string;
  sourceDir: string;
};

type PluginCreateTools = {
  cmdPluginCreate: (name: string | undefined, flags: any) => Promise<void> | void;
  parseFlags: ParseFlags;
};

type ArtifactsTools = {
  cmdArtifacts: (sub: string, args: string[], flags: any) => Promise<void> | void;
  parseFlags: ParseFlags;
};

type AgentsTools = {
  cmdAgents: (opts: { json?: boolean; all?: boolean; node?: string }) => Promise<void> | void;
  parseFlags: ParseFlags;
};

type TmuxTools = {
  tmuxHandler: (ctx: { source: "cli"; args: string[]; writer: (...a: unknown[]) => void }) => Promise<InvokeResult> | InvokeResult;
};

type ServeStatusTools = {
  printServeStatusWithPlugins: () => Promise<void> | void;
  stopServe: () => Promise<void> | void;
};

type ServeStartTools = {
  acquirePidLock: (instanceName: string | null, opts: { forceTakeover: boolean }) => void;
  startServer: (port: number) => Promise<void> | void;
};

type CoreServerTools = {
  startServer: (port: number) => Promise<void> | void;
};
type CoreServerLoader = () => Promise<CoreServerTools>;

export type RouteToolsDeps = {
  log: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
  stdoutWrite: (chunk: string) => void;
  exit: (code?: number) => never;
  paths: PathTools;
  loadPluginLegacyTools: () => Promise<PluginLegacyTools>;
  loadPluginLifecycleTools: () => Promise<PluginLifecycleTools>;
  loadPluginCreateTools: () => Promise<PluginCreateTools>;
  loadArtifactsTools: () => Promise<ArtifactsTools>;
  loadAgentsTools: () => Promise<AgentsTools>;
  loadAuditTools: () => Promise<{ cmdAudit: (args: string[]) => Promise<void> | void }>;
  loadTmuxTools: () => Promise<TmuxTools>;
  loadServeStatusTools: () => Promise<ServeStatusTools>;
  loadServeStartTools: () => Promise<ServeStartTools>;
};

export function createDefaultRouteToolsDeps(loadCoreServer?: CoreServerLoader): RouteToolsDeps {
  return {
    log: (...a: unknown[]) => console.log(...a),
    error: (...a: unknown[]) => console.error(...a),
    stdoutWrite: (chunk: string) => { process.stdout.write(chunk); },
    exit: (code?: number) => process.exit(code),
    paths: { resolve, join, existsSync, homedir, sourceDir: import.meta.dir },
    loadPluginLegacyTools: async () => {
      const [{ cmdPlugins }, { parseFlags }] = await Promise.all([
        import("../commands/shared/plugins"),
        import("./parse-args"),
      ]);
      return { cmdPlugins, parseFlags };
    },
    loadPluginLifecycleTools: async () => {
      const [{ loadManifestFromDir }, { invokePlugin }] = await Promise.all([
        import("../plugin/manifest"),
        import("../plugin/registry"),
      ]);
      return { loadManifestFromDir, invokePlugin };
    },
    loadPluginCreateTools: async () => {
      const [{ cmdPluginCreate }, { parseFlags }] = await Promise.all([
        import("../commands/shared/plugin-create"),
        import("./parse-args"),
      ]);
      return { cmdPluginCreate, parseFlags };
    },
    loadArtifactsTools: async () => {
      const [{ cmdArtifacts }, { parseFlags }] = await Promise.all([
        import("../commands/shared/artifacts"),
        import("./parse-args"),
      ]);
      return { cmdArtifacts, parseFlags };
    },
    loadAgentsTools: async () => {
      const [{ cmdAgents }, { parseFlags }] = await Promise.all([
        import("../commands/shared/agents"),
        import("./parse-args"),
      ]);
      return { cmdAgents, parseFlags };
    },
    loadAuditTools: async () => {
      const { cmdAudit } = await import("../commands/shared/audit");
      return { cmdAudit };
    },
    loadTmuxTools: async () => {
      const { default: tmuxHandler } = await import("../commands/plugins/tmux/index");
      return { tmuxHandler };
    },
    loadServeStatusTools: async () => {
      const { printServeStatusWithPlugins, stopServe } = await import("./instance-pid");
      return { printServeStatusWithPlugins, stopServe };
    },
    loadServeStartTools: async () => {
      const { acquirePidLock } = await import("./instance-pid");
      return {
        acquirePidLock,
        startServer: async (port: number) => {
          const { startServer } = loadCoreServer ? await loadCoreServer() : await import("../core/server");
          await startServer(port);
        },
      };
    },
  };
}

export function hasHelpFlag(args: string[]): boolean {
  return args.some(a => a === "--help" || a === "-h");
}

export async function routeTools(cmd: string, args: string[]): Promise<boolean> {
  return routeToolsWithDeps(cmd, args, createDefaultRouteToolsDeps());
}

export async function routeToolsWithDeps(cmd: string, args: string[], deps: RouteToolsDeps): Promise<boolean> {
  // Short-circuit --help for core routes — prints usage and does NO work.
  if (CORE_HELP[cmd] && hasHelpFlag(args.slice(1))) {
    deps.log(CORE_HELP[cmd]);
    return true;
  }
  if (cmd === "plugins") {
    const { cmdPlugins, parseFlags } = await deps.loadPluginLegacyTools();
    const sub = args[1] ?? "ls";
    const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean, "--all": Boolean }, 2);
    await cmdPlugins(sub, args.slice(2), flags);
    return true;
  }
  if (cmd === "plugin") {
    const sub = args[1]?.toLowerCase();
    // "maw plugin init|build|install|search|registry|pin|unpin|dev" →
    // forward to the plugin-lifecycle plugin (marketplace pipeline).
    const lifecycleSubs = new Set(["init", "build", "install", "search", "registry", "pin", "unpin", "dev"]);
    if (sub && lifecycleSubs.has(sub)) {
      const { loadManifestFromDir, invokePlugin } = await deps.loadPluginLifecycleTools();
      const { resolve, join, existsSync, homedir, sourceDir } = deps.paths;
      // #853 — `import.meta.dir` resolves to the source tree in dev but to
      // `~/.local/bin/` in the bundled binary, where there's no
      // commands/plugins/ subtree. Try the dev path first, then fall back to
      // the bootstrapped symlink at ~/.maw/plugins/plugin (populated by
      // runBootstrap on every CLI start).
      const candidates = [
        resolve(sourceDir, "..", "commands", "plugins", "plugin"),
        join(homedir(), ".maw", "plugins", "plugin"),
      ];
      const pluginDir = candidates.find(p => existsSync(join(p, "plugin.json")));
      if (pluginDir) {
        const loaded = loadManifestFromDir(pluginDir);
        if (loaded) {
          const result = await invokePlugin(loaded, { source: "cli", args: args.slice(1) });
          if (result.ok && result.output) deps.log(result.output);
          if (!result.ok && result.error) deps.error(result.error);
          if (!result.ok) deps.exit(1);
          return true;
        }
      }
    }
    // "maw plugin ls/info/remove" → forward to plugins (plural) legacy handler.
    // `install` is NOT in this list anymore — it's handled above by the new
    // install-impl.ts via the plugin dispatcher.
    if (sub && ["ls", "list", "info", "remove", "uninstall", "rm", "lean", "standard", "full", "nuke", "enable", "disable"].includes(sub)) {
      const { cmdPlugins, parseFlags } = await deps.loadPluginLegacyTools();
      const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean, "--all": Boolean }, 2);
      await cmdPlugins(sub, args.slice(2), flags);
      return true;
    }
    if (sub === "create") {
      const { cmdPluginCreate, parseFlags } = await deps.loadPluginCreateTools();
      const flags = parseFlags(args, {
        "--rust": Boolean,
        "--as": Boolean,
        "--here": Boolean,
        "--dest": String,
      }, 2);
      await cmdPluginCreate(flags._[0], flags);
    } else {
      deps.error("usage: maw plugin create [--rust | --as] <name> [--here]");
      deps.exit(1);
    }
    return true;
  }
  if (cmd === "artifacts" || cmd === "artifact") {
    const { cmdArtifacts, parseFlags } = await deps.loadArtifactsTools();
    const sub = args[1] ?? "ls";
    const flags = parseFlags(args, { "--json": Boolean }, 2);
    await cmdArtifacts(sub, args.slice(2), flags);
    return true;
  }
  if (cmd === "agents" || cmd === "agent") {
    const { cmdAgents, parseFlags } = await deps.loadAgentsTools();
    const flags = parseFlags(args, { "--json": Boolean, "--all": Boolean, "--node": String }, 1);
    await cmdAgents({ json: flags["--json"], all: flags["--all"], node: flags["--node"] });
    return true;
  }
  if (cmd === "audit") {
    const { cmdAudit } = await deps.loadAuditTools();
    await cmdAudit(args.slice(1));
    return true;
  }
  if (cmd === "tmux") {
    // #1459 — route the tmux command through its handler directly, with a
    // CLI InvokeContext so output streams to process.stdout.
    const { tmuxHandler } = await deps.loadTmuxTools();
    const result = await tmuxHandler({
      source: "cli",
      args: args.slice(1),
      // Do not pass `console.log` here. The core tmux handler temporarily
      // wraps console.log so command implementations can keep using it; a
      // writer that calls console.log re-enters that wrapper and recurses
      // until "Maximum call stack size exceeded" (#1459).
      writer: (...a: unknown[]) => {
        deps.stdoutWrite(`${a.map(String).join(" ")}\n`);
      },
    });
    if (!result.ok) {
      if (result.error) deps.error(result.error);
      deps.exit(result.exitCode ?? 1);
    }
    return true;
  }
  if (cmd === "serve") {
    // Strip `--as <name>` from the flag check — already consumed by
    // applyInstancePreset() in cli.ts. Any OTHER flag is still a typo.
    const serveArgs = args.slice(1);
    const asIdx = serveArgs.indexOf("--as");
    const forceIdx = serveArgs.indexOf("--force-takeover");
    const withoutAs = asIdx === -1
      ? serveArgs
      : [...serveArgs.slice(0, asIdx), ...serveArgs.slice(asIdx + 2)];
    const filteredArgs = forceIdx === -1
      ? withoutAs
      : withoutAs.filter(a => a !== "--force-takeover");
    const sub = filteredArgs[0] === "--status" ? "status" : filteredArgs[0];
    if (sub === "status" || sub === "stop") {
      const { printServeStatusWithPlugins, stopServe } = await deps.loadServeStatusTools();
      if (sub === "status") await printServeStatusWithPlugins();
      else await stopServe();
      return true;
    }
    // Reject unknown flags BEFORE starting the server — alpha.72 gate already
    // caught --help (hasHelpFlag). Anything else starting with "-" is a typo.
    // Footgun without this: `maw serve --unknown-flag` silently started a
    // duplicate server (integration-tester iter 13 recon).
    const unknownFlag = filteredArgs.find(a => a.startsWith("-"));
    if (unknownFlag) {
      deps.error(`\x1b[31m✗\x1b[0m unknown flag '${unknownFlag}' for 'maw serve'`);
      deps.error(`  usage: maw serve [port] [--as <name>] [--force-takeover]  (run 'maw serve --help' for more)`);
      throw new UserError(`unknown flag '${unknownFlag}'`);
    }
    const portArg = filteredArgs.find(a => /^\d+$/.test(a));
    // PID handshake (#566) — refuse if another maw serve is already running
    // under the same MAW_HOME.
    const { acquirePidLock, startServer } = await deps.loadServeStartTools();
    const instanceName = asIdx === -1 ? null : serveArgs[asIdx + 1];
    acquirePidLock(instanceName, { forceTakeover: forceIdx !== -1 });
    await startServer(portArg ? +portArg : 3456);
    return true;
  }
  return false;
}
