import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdShellenv } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "shellenv",
  description:
    "Emit shell init code for eval-style installation (adds maw warp).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = (ctx.source === "cli" ? (ctx.args as string[]) : []) ?? [];
  const flags = parseFlags(
    args,
    {
      "--help": Boolean,
      "-h": "--help",
    },
    0,
  );

  const shell = flags._[0];

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
    await cmdShellenv(shell, { help: flags["--help"] });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: logs.join("\n") || msg,
      output: logs.join("\n") || undefined,
      exitCode: 1,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
