import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "pane",
  description: "Pane workflow helpers such as swapping panes in the current tmux window.",
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
      console.log("\x1b[33m⚠\x1b[0m pane requires tmux");
      return { ok: false, error: "not in tmux" };
    }

    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "--help" || sub === "-h") {
      console.log("usage: maw pane swap <pane-a> <pane-b>");
      console.log("  pane targets: index (1), pane id (%1), title prefix (tile-1), top, bottom");
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (sub !== "swap") {
      console.log(`unknown pane subcommand: ${sub}`);
      console.log("usage: maw pane swap <pane-a> <pane-b>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    const a = args[1];
    const b = args[2];
    if (!a || !b) {
      console.log("usage: maw pane swap <pane-a> <pane-b>");
      return { ok: false, error: "two pane targets required", output: logs.join("\n") };
    }

    const { cmdTileSwap } = await import("../tile/impl");
    await cmdTileSwap(a, b);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
