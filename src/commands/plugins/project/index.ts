import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "project",
  description: "Scaffold (stub): clone and track external repos (learn/incubate/find/list).",
};

/**
 * maw project — core plugin scaffold (#523).
 *
 * This is a migration scaffold for the Oracle skill `/project`. The full
 * implementation (ghq clone + symlink flow into ψ/learn and ψ/incubate,
 * search across tracked repos, list across both roots, --offload /
 * --contribute / --flash workflow flags) lives in ~/.claude/skills/
 * project/SKILL.md and ships in a follow-up PR.
 *
 * Today the plugin only:
 *   - registers the CLI verb
 *   - dispatches on the first positional arg to one of four stubs
 *   - prints help on missing / unknown subcommand
 *
 * See issue #523 for the follow-up implementation tracker.
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { stubLearn, stubIncubate, stubFind, stubList, helpText } = await import("./impl");

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
    const positional = args.filter(a => !a.startsWith("--"));
    const sub = positional[0];
    const rest = positional.slice(1);

    if (!sub) {
      const help = helpText();
      console.log(help);
      return { ok: true, output: logs.join("\n") || help };
    }

    let result: string;
    switch (sub) {
      case "learn":
        if (!rest[0]) return { ok: false, error: "usage: maw project learn <url>" };
        result = await stubLearn(rest[0]);
        break;
      case "incubate":
        if (!rest[0]) return { ok: false, error: "usage: maw project incubate <url>" };
        result = await stubIncubate(rest[0]);
        break;
      case "find":
      case "search":
        if (!rest[0]) return { ok: false, error: "usage: maw project find <query>" };
        result = await stubFind(rest[0]);
        break;
      case "list":
        result = await stubList();
        break;
      default: {
        const help = helpText();
        console.log(help);
        return {
          ok: false,
          error: `maw project: unknown subcommand "${sub}" (expected learn|incubate|find|list)`,
          output: logs.join("\n") || help,
        };
      }
    }

    return { ok: true, output: logs.join("\n") || result };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
