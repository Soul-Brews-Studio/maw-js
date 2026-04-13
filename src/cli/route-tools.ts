export async function routeTools(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "plugins") {
    const { cmdPlugins } = await import("../commands/shared/plugins");
    const { parseFlags } = await import("./parse-args");
    const sub = args[1] ?? "ls";
    const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean }, 2);
    await cmdPlugins(sub, args.slice(2), flags);
    return true;
  }
  if (cmd === "plugin") {
    const sub = args[1]?.toLowerCase();
    // "maw plugin ls/info/install/remove" → forward to plugins (plural) handler
    if (sub && ["ls", "list", "info", "install", "remove", "uninstall", "rm", "lean", "nuke", "enable", "disable"].includes(sub)) {
      const { cmdPlugins } = await import("../commands/shared/plugins");
      const { parseFlags } = await import("./parse-args");
      const flags = parseFlags(args, { "--json": Boolean, "--force": Boolean }, 2);
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
  if (cmd === "serve") {
    const portArg = args.find(a => a !== "serve" && /^\d+$/.test(a));
    const { startServer } = await import("../core/server");
    startServer(portArg ? +portArg : 3456);
    return true;
  }
  return false;
}
