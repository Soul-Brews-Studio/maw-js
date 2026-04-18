import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "learn",
  description: "Scaffold (stub): explore a codebase with parallel agents.",
};

/**
 * maw learn — core plugin scaffold (#521).
 *
 * This is a migration scaffold for the Oracle skill `/learn`. The full
 * implementation (parallel Haiku agents, ghq + symlink flow, .origins
 * manifest, docs generation) lives in ~/.claude/skills/learn/SKILL.md
 * and ships in a follow-up PR.
 *
 * Today the plugin only:
 *   - registers the CLI verb + flags
 *   - validates positional args + flag shape
 *   - returns a stub message pointing users at the Oracle skill
 *
 * See issue #521 for the follow-up implementation tracker.
 */
export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { cmdLearn } = await import("./impl");

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

    const fast = args.includes("--fast");
    const deep = args.includes("--deep");
    if (fast && deep) {
      return {
        ok: false,
        error: "maw learn: --fast and --deep are mutually exclusive",
      };
    }

    const positional = args.filter(a => !a.startsWith("--"));
    const unknown = args.filter(a => a.startsWith("--") && a !== "--fast" && a !== "--deep");
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `maw learn: unknown flag(s) ${unknown.join(", ")} (accepts --fast, --deep)`,
      };
    }

    if (!positional[0]) {
      return {
        ok: false,
        error: "usage: maw learn <repo> [--fast|--deep]",
      };
    }

    const mode = fast ? "fast" : deep ? "deep" : "default";
    const result = await cmdLearn(positional[0], mode);
    return { ok: true, output: logs.join("\n") || result };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
