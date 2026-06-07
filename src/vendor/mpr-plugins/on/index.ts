import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "on",
  description: "Create event triggers for oracle lifecycle events.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { loadConfig, saveConfig } = await import("maw-js/config");

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

    const oracle = args[0];
    const event = args[1] as "agent-idle" | "agent-wake" | "agent-crash";
    const isOnce = args.includes("--once");
    const actionIdx = args.indexOf("--once") !== -1 ? args.indexOf("--once") + 1 : 2;
    const timeoutIdx = args.indexOf("--timeout");
    const timeout = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1]) : 30;

    // Filter out --once, --timeout, and its value from the action parts
    const action = args.slice(actionIdx).filter((a, i, arr) => {
      if (a === "--once") return false;
      if (a === "--timeout") return false;
      // skip the value after --timeout
      if (i > 0 && arr[i - 1] === "--timeout") return false;
      return true;
    }).join(" ");

    if (!oracle || !event || !action) {
      console.log(`\x1b[36mUsage:\x1b[0m maw on <oracle> <event> [--once] [--timeout N] "<action>"`);
      console.log(`\n\x1b[33mEvents:\x1b[0m agent-idle, agent-wake, agent-crash`);
      console.log(`\n\x1b[33mExamples:\x1b[0m`);
      console.log(`  maw on neo idle --once "maw hey homekeeper 'neo done'"`);
      console.log(`  maw on neo crash "maw wake neo"`);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const config = loadConfig();
    const trigger = {
      on: `agent-${event}` as any,
      repo: oracle,
      timeout,
      action,
      name: `on-${oracle}-${event}`,
      once: isOnce || undefined,
    };
    const triggers = [...(config.triggers || []), trigger];
    saveConfig({ triggers });

    const badge = isOnce ? " \x1b[33m[once]\x1b[0m" : "";
    console.log(`\x1b[32m✓\x1b[0m trigger added: on ${oracle} ${event}${badge} → ${action}`);

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
