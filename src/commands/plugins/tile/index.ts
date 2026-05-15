import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "tile",
  description: "Tile current window or spawn N colored panes in a tiled grid.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    if (!process.env.TMUX) {
      console.log("\x1b[33m⚠\x1b[0m tile requires tmux");
      return { ok: false, error: "not in tmux" };
    }

    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const flags = parseFlags(args, {
      "--help": Boolean, "-h": "--help",
      "--wt": Boolean,
      "--engine": String, "-e": "--engine",
    }, 0);

    if (flags["--help"]) {
      console.log("usage: maw tile [N] [--wt] [--engine <name>]");
      console.log("       maw tile clean");
      console.log("");
      console.log("  maw tile              apply tiled layout to current window");
      console.log("  maw tile 3            spawn 3 empty panes and tile them");
      console.log("  maw tile 3 --wt       spawn 3 worktree-backed panes, each with own branch");
      console.log("  maw tile 3 -e claude  spawn 3 panes running claude, tiled");
      console.log("  maw tile clean        kill tile panes + remove tile worktrees");
      return { ok: true, output: logs.join("\n") };
    }

    const positional = flags._ as string[];

    if (positional[0] === "clean") {
      const { cmdTileClean } = await import("./impl");
      await cmdTileClean();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const { cmdTile } = await import("./impl");
    const count = positional[0] ? parseInt(positional[0], 10) : 0;

    if (isNaN(count)) {
      console.log("\x1b[33m⚠\x1b[0m tile: expected a number, got '" + positional[0] + "'");
      return { ok: false, error: "invalid count" };
    }

    await cmdTile(count, {
      wt: !!flags["--wt"],
      engine: flags["--engine"] as string | undefined,
    });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
