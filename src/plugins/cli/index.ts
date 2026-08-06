import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdCli as realCmdCli } from "./impl";

export const command = {
  name: "cli",
  description: "Print a ready-to-paste Claude CLI invocation for an oracle context.",
};

type CliDeps = {
  cmdCli: typeof realCmdCli;
};

const defaultDeps: CliDeps = { cmdCli: realCmdCli };

export function createCliHandler(overrides: Partial<CliDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };

  return async function handler(ctx: InvokeContext): Promise<InvokeResult> {
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
      const flags = parseFlags(args, { "--json": Boolean }, 0);
      const target = flags._[0];
      await deps.cmdCli(target, { json: flags["--json"] });
      return { ok: true, output: logs.join("\n") || undefined };
    } catch (e: any) {
      return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  };
}

export default createCliHandler();
