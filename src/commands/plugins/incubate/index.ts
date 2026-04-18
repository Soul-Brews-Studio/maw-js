import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "incubate",
  description: "Scaffold (stub): clone or create repos for active development.",
};

/**
 * maw incubate — core plugin scaffold (#522).
 *
 * This is a migration scaffold for the Oracle skill `/incubate`. The full
 * implementation (ghq clone/create, origin symlink, .origins manifest,
 * INCUBATED_BY breadcrumb, hub file, --flash/--contribute/--status/--offload
 * workflow modes) lives in ~/.claude/skills/incubate/SKILL.md and ships in a
 * follow-up PR.
 *
 * Today the plugin only:
 *   - registers the CLI verb + flags
 *   - validates positional args + flag shape
 *   - returns a stub message pointing users at the Oracle skill
 *
 * See issue #522 for the follow-up implementation tracker.
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { cmdIncubate } = await import("./impl");

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

    const flash = args.includes("--flash");
    const contribute = args.includes("--contribute");
    const status = args.includes("--status");
    const offload = args.includes("--offload");

    const modes = [flash, contribute, status, offload].filter(Boolean).length;
    if (modes > 1) {
      return {
        ok: false,
        error: "maw incubate: --flash, --contribute, --status, --offload are mutually exclusive",
      };
    }

    const known = new Set(["--flash", "--contribute", "--status", "--offload"]);
    const positional = args.filter(a => !a.startsWith("--"));
    const unknown = args.filter(a => a.startsWith("--") && !known.has(a));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `maw incubate: unknown flag(s) ${unknown.join(", ")} (accepts --flash, --contribute, --status, --offload)`,
      };
    }

    const mode = flash ? "flash" : contribute ? "contribute" : status ? "status" : offload ? "offload" : "default";

    if (mode !== "status" && !positional[0]) {
      return {
        ok: false,
        error: "usage: maw incubate <repo> [--flash|--contribute|--status|--offload]",
      };
    }

    const result = await cmdIncubate(positional[0] ?? "", mode);
    return { ok: true, output: logs.join("\n") || result };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
