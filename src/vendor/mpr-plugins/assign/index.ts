import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdAssign } from "./impl";

export const command = {
  name: "assign",
  description: "Assign a GitHub issue to an oracle.",
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
    if (!args[0]) {
      throw new Error("usage: maw assign <issue-url> [--oracle <name>]");
    }
    const oracleIdx = args.indexOf("--oracle");
    const oracle = oracleIdx !== -1 ? args[oracleIdx + 1] : undefined;
    const issueUrl = args.filter((a, i) => a !== "--oracle" && (oracleIdx === -1 || i !== oracleIdx + 1))[0];
    await cmdAssign(issueUrl, { oracle });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
