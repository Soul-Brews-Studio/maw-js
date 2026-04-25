import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdLexiconVerify } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "lexicon-verify",
  description: "Verify files use canonical Oracle lexicon terms",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const flags = parseFlags(args, {
      "--glossary": String,
      "--fix": Boolean,
      "--json": Boolean,
    }, 0);

    const result = await cmdLexiconVerify({
      paths: flags._.length > 0 ? flags._ : undefined,
      glossaryPath: flags["--glossary"],
      fix: !!flags["--fix"],
      json: !!flags["--json"],
    });

    return { ok: result.violations === 0, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
