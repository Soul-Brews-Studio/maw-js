// #388.1 — core-route usage strings for --help intercept. These routes don't
// pass through invokePlugin, so they need their own --help guard to prevent
// `maw plugin list --help` / `maw agents --help` from running real work.
const CORE_HELP: Record<string, string> = {
  plugins: "usage: maw plugins [ls|info <name>|remove <name>|lean|standard|full|nuke|enable <name>|disable <name>] [--json] [--all] [--force]",
  plugin: "usage: maw plugin <init|build|install|create|ls|info|remove|enable|disable> [args]",
  artifacts: "usage: maw artifacts [ls|get] [team] [task-id] [--json]",
  artifact: "usage: maw artifact [ls|get] [team] [task-id] [--json]",
  agents: "usage: maw agents [--json] [--all] [--node <node>]",
  agent: "usage: maw agent [--json] [--all] [--node <node>]",
  audit: "usage: maw audit [limit]",
  serve: "usage: maw serve [port] [--as <name>]",
};

function hasHelpFlag(args: string[]): boolean {
  return args.some(a => a === "--help" || a === "-h");
}

export async function routeTools(cmd: string, args: string[]): Promise<boolean> {
  // Short-circuit --help for core routes — prints usage and does NO work.
  if (CORE_HELP[cmd] && hasHelpFlag(args.slice(1))) {
    console.log(CORE_HELP[cmd]);
    return true;
  }
  if (cmd === "plugins") {
    const { cmdPlugins } = await import("../commands/shared/plugins");
    const { parseFlags } = await import("./parse-args");
    const sub = args[1] ?? "ls";
    const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean, "--all": Boolean }, 2);
    await cmdPlugins(sub, args.slice(2), flags);
    return true;
  }
  if (cmd === "plugin") {
    const sub = args[1]?.toLowerCase();
    // "maw plugin init|build|install" → forward to the plugin-lifecycle
    // plugin (tasks #2 + #3 both landed).
    if (sub === "init" || sub === "build" || sub === "install") {
      const { loadManifestFromDir } = await import("../plugin/manifest");
      const { invokePlugin } = await import("../plugin/registry");
      const { resolve } = await import("path");
      const pluginDir = resolve(import.meta.dir, "..", "commands", "plugins", "plugin");
      const loaded = loadManifestFromDir(pluginDir);
      if (loaded) {
        const result = await invokePlugin(loaded, { source: "cli", args: args.slice(1) });
        if (result.ok && result.output) console.log(result.output);
        if (!result.ok && result.error) console.error(result.error);
        if (!result.ok) process.exit(1);
        return true;
      }
    }
    // "maw plugin ls/info/remove" → forward to plugins (plural) legacy handler.
    // `install` is NOT in this list anymore — it's handled above by the new
    // install-impl.ts via the plugin dispatcher.
    if (sub && ["ls", "list", "info", "remove", "uninstall", "rm", "lean", "standard", "full", "nuke", "enable", "disable"].includes(sub)) {
      const { cmdPlugins } = await import("../commands/shared/plugins");
      const { parseFlags } = await import("./parse-args");
      const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean, "--all": Boolean }, 2);
      await cmdPlugins(sub, args.slice(2), flags);
      return true;
    }
    if (sub === "create") {
      const { cmdPluginCreate } = await import("../commands/shared/plugin-create");
      const { parseFlags } = await import("./parse-args");
      const flags = parseFlags(args, {
        "--rust": Boolean,
        "--as": Boolean,
        "--here": Boolean,
        "--dest": String,
      }, 2);
      await cmdPluginCreate(flags._[0], flags);
    } else {
      console.error("usage: maw plugin create [--rust | --as] <name> [--here]");
      process.exit(1);
    }
    return true;
  }
  if (cmd === "artifacts" || cmd === "artifact") {
    const { cmdArtifacts } = await import("../commands/shared/artifacts");
    const { parseFlags } = await import("./parse-args");
    const sub = args[1] ?? "ls";
    const flags = parseFlags(args, { "--json": Boolean }, 2);
    await cmdArtifacts(sub, args.slice(2), flags);
    return true;
  }
  if (cmd === "agents" || cmd === "agent") {
    const { cmdAgents } = await import("../commands/shared/agents");
    const { parseFlags } = await import("./parse-args");
    const flags = parseFlags(args, { "--json": Boolean, "--all": Boolean, "--node": String }, 1);
    await cmdAgents({ json: flags["--json"], all: flags["--all"], node: flags["--node"] });
    return true;
  }
  if (cmd === "audit") {
    const { cmdAudit } = await import("../commands/shared/audit");
    await cmdAudit(args.slice(1));
    return true;
  }
  if (cmd === "serve") {
    // Strip `--as <name>` from the flag check — already consumed by
    // applyInstancePreset() in cli.ts. Any OTHER flag is still a typo.
    const serveArgs = args.slice(1);
    const asIdx = serveArgs.indexOf("--as");
    const filteredArgs = asIdx === -1
      ? serveArgs
      : [...serveArgs.slice(0, asIdx), ...serveArgs.slice(asIdx + 2)];
    // Reject unknown flags BEFORE starting the server — alpha.72 gate already
    // caught --help (hasHelpFlag). Anything else starting with "-" is a typo.
    // Footgun without this: `maw serve --unknown-flag` silently started a
    // duplicate server (integration-tester iter 13 recon).
    const unknownFlag = filteredArgs.find(a => a.startsWith("-"));
    if (unknownFlag) {
      const { UserError } = await import("../core/util/user-error");
      console.error(`\x1b[31m✗\x1b[0m unknown flag '${unknownFlag}' for 'maw serve'`);
      console.error(`  usage: maw serve [port] [--as <name>]  (run 'maw serve --help' for more)`);
      throw new UserError(`unknown flag '${unknownFlag}'`);
    }
    const portArg = filteredArgs.find(a => /^\d+$/.test(a));
    // PID handshake (#566) — refuse if another maw serve is already running
    // under the same MAW_HOME.
    const { acquirePidLock } = await import("./instance-pid");
    const instanceName = asIdx === -1 ? null : serveArgs[asIdx + 1];
    acquirePidLock(instanceName);
    const { startServer } = await import("../core/server");
    startServer(portArg ? +portArg : 3456);
    return true;
  }
  return false;
}
