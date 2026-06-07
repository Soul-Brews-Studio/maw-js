import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdOracleAbout } from "./internal/impl-about";

export const command = {
  name: ["about", "info"],
  description: "Show information about an oracle (session, repo, windows).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
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
    let oracle: string;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      if (!args[0]) {
        return { ok: false, error: "usage: maw about <oracle>" };
      }
      oracle = args[0];
    } else {
      const args = ctx.args as Record<string, unknown>;
      if (!args.oracle) {
        return { ok: false, error: "oracle is required" };
      }
      oracle = args.oracle as string;
    }

    await cmdOracleAbout(oracle);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
