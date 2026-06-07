import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdMegaStatus, cmdMegaStop } from "./impl";

export const command = {
  name: "mega",
  description: "Manage MegaAgent multi-agent teams.",
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
    const sub = args[0]?.toLowerCase();
    if (sub === "stop" || sub === "kill") {
      await cmdMegaStop();
    } else if (sub === "status" || sub === "ls" || sub === "tree" || !sub) {
      await cmdMegaStatus();
    } else {
      console.log("maw mega — MegaAgent hierarchical multi-agent system\n");
      console.log("  maw mega              Show all teams (hierarchy tree)");
      console.log("  maw mega status       Same as above");
      console.log("  maw mega stop         Kill all active team panes");
    }
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
