import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { cmdContactsLs, cmdContactsAdd, cmdContactsRm } from "./impl";

export const command = {
  name: ["contacts", "contact"],
  description: "Manage oracle contacts — add, remove, list",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const sub = args[0]?.toLowerCase();
      if (sub === "add" && args[1]) {
        await cmdContactsAdd(args[1], args.slice(2));
      } else if (sub === "rm" || sub === "remove") {
        if (!args[1]) { logs.push("usage: maw contacts rm <name>"); return { ok: false, error: "name required" }; }
        await cmdContactsRm(args[1]);
      } else {
        await cmdContactsLs();
      }
    } else if (ctx.source === "api") {
      const body = ctx.args as Record<string, unknown>;
      const method = body.method as string | undefined;
      if (!method || method === "GET") {
        await cmdContactsLs();
      } else if (method === "POST") {
        const action = body.action as string;
        const name = body.name as string;
        if (!name) return { ok: false, error: "name required" };
        if (action === "add") {
          const transport = body.transport as string | undefined;
          await cmdContactsAdd(name, transport ? ["--maw", transport] : []);
        } else if (action === "rm") {
          await cmdContactsRm(name);
        } else {
          return { ok: false, error: `unknown action: ${action}` };
        }
      }
    } else {
      await cmdContactsLs();
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
