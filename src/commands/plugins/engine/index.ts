import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { ENGINE_DEFS, ENGINE_NAMES, isEngineInstalled, resolveDefaultEngine, type EngineName } from "../../shared/engines";

export const command = {
  name: "engine",
  description: "Manage AI engine backends — list, check, set default.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push((a as unknown[]).map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (sub === "ls" || sub === "list" || !sub) {
      const current = resolveDefaultEngine();
      const json = args.includes("--json");

      if (json) {
        const data = ENGINE_NAMES.map(name => ({
          name,
          binary: ENGINE_DEFS[name].binary,
          defaultModel: ENGINE_DEFS[name].defaultModel,
          promptMode: ENGINE_DEFS[name].promptMode,
          installed: isEngineInstalled(name),
          active: name === current,
        }));
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`  \x1b[36;1mEngine${" ".repeat(12)}Binary${" ".repeat(10)}Model${" ".repeat(12)}Mode${" ".repeat(4)}Status\x1b[0m`);
        console.log(`  ${"─".repeat(18)}${"─".repeat(16)}${"─".repeat(17)}${"─".repeat(8)}${"─".repeat(16)}`);
        for (const name of ENGINE_NAMES) {
          const e = ENGINE_DEFS[name];
          const installed = isEngineInstalled(name);
          const status = installed ? "\x1b[32m✓ installed\x1b[0m" : "\x1b[90mnot found\x1b[0m";
          const active = name === current ? " \x1b[33m←\x1b[0m" : "";
          console.log(
            `  ${name.padEnd(18)}${e.binary.padEnd(16)}${e.defaultModel.padEnd(17)}${e.promptMode.padEnd(8)}${status}${active}`,
          );
        }
        console.log(`\n  default: \x1b[36m${current}\x1b[0m (override: --engine <name>, $MAW_ENGINE, .claude/engine.json)`);
      }

    } else if (sub === "check") {
      const target = args[1];
      if (target) {
        const name = target as EngineName;
        if (!(name in ENGINE_DEFS)) {
          console.log(`  \x1b[31m✗\x1b[0m unknown engine: ${name}`);
          console.log(`  available: ${ENGINE_NAMES.join(", ")}`);
          return { ok: false, error: `unknown engine: ${name}` };
        }
        const installed = isEngineInstalled(name);
        const e = ENGINE_DEFS[name];
        console.log(`  ${installed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}: ${e.binary} ${installed ? "(installed)" : "(not found in PATH)"}`);
        if (!installed) {
          console.log(`  install: check ${e.binary} documentation`);
        }
      } else {
        let installed = 0;
        for (const name of ENGINE_NAMES) {
          const ok = isEngineInstalled(name);
          if (ok) installed++;
          console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name} (${ENGINE_DEFS[name].binary})`);
        }
        console.log(`\n  ${installed}/${ENGINE_NAMES.length} engines installed`);
      }

    } else {
      console.log("usage: maw engine <ls|check> [engine-name] [--json]");
      console.log("");
      console.log("  maw engine ls              list all engines + install status");
      console.log("  maw engine ls --json       machine-readable output");
      console.log("  maw engine check           check all engines installed");
      console.log("  maw engine check codex     check specific engine");
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
