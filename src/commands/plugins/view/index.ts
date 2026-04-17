import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "view",
  description: "Create or attach to an agent's tmux view.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { cmdView } = await import("./impl");

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

    if (!args[0]) {
      return {
        ok: false,
        error: "usage: maw view <agent> [window] [--clean] [--kill]",
      };
    }

    const clean = args.includes("--clean");
    const kill = args.includes("--kill");
    const filtered = args.filter(a => a !== "--clean" && a !== "--kill");
    await cmdView(filtered[0], filtered[1], clean, kill);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
