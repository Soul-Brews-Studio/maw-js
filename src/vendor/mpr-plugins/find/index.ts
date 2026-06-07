import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdFind } from "./impl";

export const command = {
  name: "find",
  description: "Search across agents and fleet data.",
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
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    if (!args[0]) throw new Error("usage: maw find <keyword> [--oracle <name>]");
    const oracleIdx = args.indexOf("--oracle");
    await cmdFind(args[0], { oracle: oracleIdx !== -1 ? args[oracleIdx + 1] : undefined });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
