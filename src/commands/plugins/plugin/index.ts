import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "plugin",
  description: "Plugin lifecycle — init, build, dev, install.",
};

const USAGE =
  "usage: maw plugin <init|build|dev|install|pin|unpin> [args]\n" +
  "  init <name> --ts                    scaffold a TS plugin\n" +
  "  build [dir] [--watch] [--types]     bundle + pack a plugin\n" +
  "                                        --types: emit dist/<name>.d.ts\n" +
  "  dev [dir] [--types]                 watch mode (alias for build --watch, DX verb)\n" +
  "  install <dir | .tgz | URL> [--pin]  install a built plugin\n" +
  "                                        --pin: add to plugins.lock on first install\n" +
  "  pin <name> <tarball> [--version V]  add/update plugins.lock entry (#487)\n" +
  "  unpin <name>                        remove a plugins.lock entry";

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0];

    if (!sub || sub === "--help" || sub === "-h") {
      return { ok: true, output: USAGE };
    }

    if (sub === "init") {
      const { cmdPluginInit } = await import("./init-impl");
      await cmdPluginInit(args.slice(1));
    } else if (sub === "build") {
      const { cmdPluginBuild } = await import("./build-impl");
      await cmdPluginBuild(args.slice(1));
    } else if (sub === "dev") {
      const { cmdPluginDev } = await import("./build-impl");
      await cmdPluginDev(args.slice(1));
    } else if (sub === "pin") {
      const { cmdPluginPin } = await import("./lock-cli");
      await cmdPluginPin(args.slice(1));
    } else if (sub === "unpin") {
      const { cmdPluginUnpin } = await import("./lock-cli");
      await cmdPluginUnpin(args.slice(1));
    } else if (sub === "install") {
      // installer-loader (task #3) provides install-impl.ts
      try {
        const mod: { cmdPluginInstall?: (args: string[]) => Promise<void> } = await import("./install-impl");
        if (typeof mod.cmdPluginInstall !== "function") {
          return { ok: false, error: "plugin install: install-impl.ts present but missing cmdPluginInstall export" };
        }
        await mod.cmdPluginInstall(args.slice(1));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Cannot find module/.test(msg)) {
          return {
            ok: false,
            error:
              "plugin install: not yet implemented in this build (task #3 in progress).\n" +
              "  build produces: <name>-<version>.tgz (flat tarball: plugin.json + index.js at root).",
          };
        }
        throw e;
      }
    } else {
      return { ok: false, error: `unknown plugin subcommand: ${sub}\n${USAGE}` };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: logs.length ? logs.join("\n") : msg,
      output: logs.join("\n") || undefined,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
