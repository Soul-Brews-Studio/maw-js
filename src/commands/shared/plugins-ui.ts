/**
 * plugins seam: UI helpers — table printing, path shortening, archive to tmp.
 */

import type { LoadedPlugin } from "../../plugin/types";
import { homedir } from "os";
import { renameSync } from "fs";

export function archiveToTmp(name: string, dir: string): void {
  const dest = `/tmp/maw-plugin-${name}-${Date.now()}`;
  renameSync(dir, dest);
}

export function surfaces(p: LoadedPlugin): string {
  const parts: string[] = [];
  if (p.manifest.cli) parts.push(`cli:${p.manifest.cli.command}`);
  // #899 — surfaces the default-cli-name for community plugins that omit
  // the `cli` field but still dispatch as `maw <name>` via dispatch-match's
  // pluginCliNames(). Listing was reporting "—" for these, masking the
  // surface they actually expose at runtime.
  else if (p.kind === "ts" && p.entryPath) parts.push(`cli:${p.manifest.name}`);
  else if (p.kind === "wasm" && p.wasmPath) parts.push(`cli:${p.manifest.name}`);
  if (p.manifest.api) parts.push(`api:${p.manifest.api.path}`);
  return parts.join(", ") || "—";
}

export function shortenHome(dir: string): string {
  const home = homedir();
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
}

export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)),
  );
  const sep = widths.map(w => "─".repeat(w)).join("  ");
  const fmt = (row: string[]) =>
    row.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  console.log(sep);
  for (const row of rows) console.log(fmt(row));
}
