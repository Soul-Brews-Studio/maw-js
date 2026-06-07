import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "avengers",
  description: "Manage the Avengers multi-agent team.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { cmdAvengers } = await import("./impl");

  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

  // Handle --help before monkey-patching so output always reaches stdout
  if (args[0] === "--help" || args[0] === "-h") {
    const help = [
      "usage: maw avengers [status|best|traffic|health] — ARRA-01 rate limit monitor",
      "",
      "  maw avengers status    All accounts + rate limits",
      "  maw avengers best      Account with most capacity",
      "  maw avengers traffic   Traffic stats",
      "  maw avengers health    Quick connectivity check",
    ].join("\n");
    if (ctx.writer) ctx.writer(help);
    else console.log(help);
    return { ok: true };
  }

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
    await cmdAvengers(args[0] || "status");
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
