import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { D, loadConfigWithProvenance, saveConfig } from "../../../config";

export const command = {
  name: "config",
  description: "Inspect cwd-aware maw config layers and provenance.",
};

function valueAtPath(root: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce((node: any, key) => node?.[key], root as any);
}

function builtInDefaultAtPath(keyPath: string): unknown {
  return valueAtPath(D, keyPath);
}

function builtInDefaultEntry(keyPath: string, value: unknown): ConfigProvenanceEntry {
  return {
    path: "built-in default",
    weight: Number.NEGATIVE_INFINITY,
    scope: "built-in default",
    isLocal: false,
    action: "default",
    value,
  };
}

type ConfigProvenanceEntry = {
  path: string;
  weight: number;
  scope: string;
  isLocal: boolean;
  action: string;
  value: unknown;
};

function provenanceAtPath(provenance: Record<string, unknown>, keyPath: string): ConfigProvenanceEntry[] {
  const direct = provenance[keyPath];
  if (Array.isArray(direct)) return direct as ConfigProvenanceEntry[];
  const parts = keyPath.split(".");
  while (parts.length > 1) {
    parts.pop();
    const parent = provenance[parts.join(".")];
    if (Array.isArray(parent)) return parent as ConfigProvenanceEntry[];
  }
  return [];
}

function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try { return JSON.parse(trimmed); } catch { /* keep as string */ }
  }
  return raw;
}

function objectPatchAtPath(keyPath: string, value: unknown, base: unknown): Record<string, unknown> {
  const parts = keyPath.split(".").filter(Boolean);
  if (parts.length === 0) return {};
  const root: Record<string, unknown> = {};
  let cursor = root;
  let baseCursor: any = base;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = baseCursor?.[part];
    const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
    cursor[part] = next;
    cursor = next;
    baseCursor = existing;
  }
  cursor[parts.at(-1)!] = value;
  return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const writer = ctx.writer ?? ((...args: unknown[]) => logs.push(args.map(String).join(" ")));
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
  const sub = args[0] ?? "show";
  const json = args.includes("--json");
  const loaded = loadConfigWithProvenance({ cwd: process.cwd() });

  if (sub === "set") {
    const key = args[1];
    const rawValue = args[2];
    if (!key || rawValue === undefined || key.startsWith("-")) return { ok: false, error: "usage: maw config set <key> <value>" };
    const patch = objectPatchAtPath(key, parseConfigValue(rawValue), loaded.config);
    const saved = saveConfig(patch as any);
    const finalValue = valueAtPath(saved, key);
    if (json) writer(JSON.stringify({ key, value: finalValue }, null, 2));
    else writer(`${key} = ${JSON.stringify(finalValue)}`);
    return { ok: true, output: logs.join("\n") || undefined };
  }

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
    let entries = provenanceAtPath(loaded.provenance, key);
    let finalValue = valueAtPath(loaded.config, key);
    if (finalValue === undefined) {
      const defaultValue = builtInDefaultAtPath(key);
      if (defaultValue !== undefined) {
        finalValue = defaultValue;
        entries = [builtInDefaultEntry(key, defaultValue), ...entries];
      }
    }
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

  return { ok: false, error: "usage: maw config <show|sources|explain <key>|set <key> <value>> [--json]" };
}
