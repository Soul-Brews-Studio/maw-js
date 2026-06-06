import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { loadConfigWithProvenance } from "../../../config";

export const command = {
  name: "config",
  description: "Inspect cwd-aware maw config layers and provenance.",
};

function valueAtPath(root: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce((node: any, key) => node?.[key], root as any);
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const writer = ctx.writer ?? ((...args: unknown[]) => logs.push(args.map(String).join(" ")));
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const sub = args[0] ?? "show";
  const json = args.includes("--json");
  const loaded = loadConfigWithProvenance({ cwd: process.cwd() });

  if (sub === "show") {
    writer(JSON.stringify(loaded.config, null, 2));
    return { ok: true, output: logs.join("\n") || undefined };
  }

  if (sub === "sources") {
    const rows = loaded.sources.map((source) => ({
      weight: source.weight,
      scope: source.scope,
      local: source.isLocal,
      file: source.path,
    }));
    if (json) writer(JSON.stringify({ sources: rows, warnings: loaded.warnings }, null, 2));
    else {
      for (const row of rows) writer(`${String(row.weight).padStart(3)} ${row.scope.padEnd(7)} ${row.local ? "local" : "     "} ${row.file}`);
      for (const warning of loaded.warnings) writer(warning);
    }
    return { ok: true, output: logs.join("\n") || undefined };
  }

  if (sub === "explain") {
    const key = args.find((arg, index) => index > 0 && !arg.startsWith("-"));
    if (!key) return { ok: false, error: "usage: maw config explain <key> [--json]" };
    const entries = loaded.provenance[key] ?? [];
    const finalValue = valueAtPath(loaded.config, key);
    if (json) writer(JSON.stringify({ key, finalValue, entries }, null, 2));
    else {
      writer(`key: ${key}`);
      for (const entry of entries) {
        writer(`${entry.weight} ${entry.scope}${entry.isLocal ? ".local" : ""} ${entry.action} ${entry.path}`);
        writer(`  ${JSON.stringify(entry.value)}`);
      }
      writer(`FINAL ${JSON.stringify(finalValue)}`);
    }
    return { ok: true, output: logs.join("\n") || undefined };
  }

  return { ok: false, error: "usage: maw config <show|sources|explain <key>> [--json]" };
}
