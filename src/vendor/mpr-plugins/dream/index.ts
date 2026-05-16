import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdDream } from "./impl";

export const command = {
  name: "dream",
  description: "Discover cross-repo patterns across pains, plans, gains, lost work, memory, and feelings.",
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
    const flags = parseFlags(args);
    await cmdDream(flags);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

export interface DreamFlags {
  pain: boolean;
  plan: boolean;
  gain: boolean;
  all: boolean;
  speculate: boolean;
  between: boolean;
  help: boolean;
  project?: string;
}

function parseFlags(args: string[]): DreamFlags {
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--project" || tok === "-p") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) throw new Error("--project requires a name");
      project = next; i++;
    } else if (tok.startsWith("--project=")) {
      project = tok.slice("--project=".length);
    }
  }
  return {
    pain: args.includes("--pain"),
    plan: args.includes("--plan"),
    gain: args.includes("--gain"),
    all: args.includes("--all"),
    speculate: args.includes("--speculate"),
    between: args.includes("--between"),
    help: args.includes("--help") || args.includes("-h"),
    project,
  };
}
