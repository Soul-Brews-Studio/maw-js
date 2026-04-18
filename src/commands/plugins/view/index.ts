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
    const rawArgs = ctx.source === "cli" ? (ctx.args as string[]) : [];

    // --split accepts both a bare form (`--split`, caller's active pane) and
    // a valued form (`--split=<anchor>`, anchor at another oracle's view).
    // Scan explicitly — the handler below uses includes()/filter() rather
    // than an arg parser, and the valued form needs an extra pass anyway.
    let splitAnchor: string | true | undefined = undefined;
    const scanned: string[] = [];
    for (const a of rawArgs) {
      const m = /^--split=(.+)$/.exec(a);
      if (m) {
        splitAnchor = m[1]!;
      } else if (a === "--split") {
        splitAnchor = true;
      } else {
        scanned.push(a);
      }
    }

    if (!scanned[0]) {
      return {
        ok: false,
        error: "usage: maw view <agent> [window] [--clean] [--kill] [--split[=<anchor>]]",
      };
    }

    const clean = scanned.includes("--clean");
    const kill = scanned.includes("--kill");
    const wake = scanned.includes("--wake");
    const noWake = scanned.includes("--no-wake");
    const filtered = scanned.filter(
      a => a !== "--clean" && a !== "--kill" && a !== "--wake" && a !== "--no-wake",
    );
    await cmdView(filtered[0], filtered[1], clean, kill, splitAnchor, { wake, noWake });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
