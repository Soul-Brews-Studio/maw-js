import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdAbsorb } from "./impl";

export const command = {
  name: "absorb",
  description: "Absorb one oracle into another, archive the donor, and switch to the receiver.",
};

function usage() {
  return "usage: maw absorb <donor> --into <receiver> [--dry-run]";
}

function parseArgs(args: string[]) {
  const intoIndex = args.indexOf("--into");
  const donor = args.find(arg => !arg.startsWith("--"));
  const receiver = intoIndex >= 0 ? args[intoIndex + 1] : undefined;
  const dryRun = args.includes("--dry-run");

  if (!donor || intoIndex < 0 || !receiver || receiver.startsWith("--")) {
    throw new Error(usage());
  }

  return { donor, receiver, dryRun };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

  if (args[0] === "--help" || args[0] === "-h") {
    const help = `${usage()} — absorb donor knowledge, archive donor, and switch to receiver`;
    if (ctx.writer) ctx.writer(help);
    else console.log(help);
    return { ok: true };
  }

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const write = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.log = write;
  console.error = write;

  try {
    const parsed = parseArgs(args);
    await cmdAbsorb(parsed.donor, parsed.receiver, { dryRun: parsed.dryRun });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    const output = logs.join("\n") || undefined;
    return { ok: false, error: output || e.message, output };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
