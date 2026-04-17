import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "plugin",
  description: "Plugin lifecycle — init, build, dev, install.",
};

const USAGE =
  "usage: maw plugin <init|build|dev|install> [args]\n" +
  "  init <name> --ts              scaffold a TS plugin\n" +
  "  build [dir] [--watch]         bundle + pack a plugin\n" +
  "  dev [dir]                     watch mode (alias for build --watch, DX verb)\n" +
  "  install <dir | .tgz | URL>    install a built plugin";

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
