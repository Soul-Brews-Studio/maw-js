import { spawnSync } from "child_process";
import { tlink } from "maw-js/core/util/terminal";

export interface ToolStatus {
  name: string;
  present: boolean;
  version?: string;
  required: boolean;
  category: "required" | "optional";
  installUrl: string;
  notes?: string;
}

/** Alphabetical within each category. */
export const TOOLS: Omit<ToolStatus, "present" | "version">[] = [
  { name: "bun",  required: true,  category: "required", installUrl: "https://bun.sh" },
  { name: "gh",   required: true,  category: "required", installUrl: "https://cli.github.com" },
  { name: "ghq",  required: true,  category: "required", installUrl: "https://github.com/x-motemen/ghq#install" },
  { name: "git",  required: true,  category: "required", installUrl: "https://git-scm.com/downloads" },
  { name: "tmux", required: true,  category: "required", installUrl: "https://github.com/tmux/tmux/wiki/Installing" },
  { name: "uv",   required: false, category: "optional", installUrl: "https://docs.astral.sh/uv/getting-started/installation/" },
  { name: "uvx",  required: false, category: "optional", installUrl: "https://docs.astral.sh/uv/", notes: "provided by uv" },
];

/**
 * Check whether a tool binary is present and extract its version string.
 * - tmux uses `-V` (e.g. "tmux 3.4")
 * - uvx is detected via `which` (it's a wrapper; no useful --version)
 * - all others use `--version`
 */
export function checkTool(name: string): { present: boolean; version?: string } {
  // uvx: detect presence via `which`, inherit version from uv
  if (name === "uvx") {
    const w = spawnSync("which", ["uvx"], { encoding: "utf-8" });
    if (w.error || w.status !== 0) return { present: false };
    const uv = spawnSync("uv", ["--version"], { encoding: "utf-8" });
    const output = (uv.stdout || "") + (uv.stderr || "");
    const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
    return { present: true, version: match?.[1] };
  }

  const flag = name === "tmux" ? "-V" : "--version";
  const r = spawnSync(name, [flag], { encoding: "utf-8" });

  if (r.error) return { present: false };

  const output = (r.stdout || "") + (r.stderr || "");
  const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
  return { present: true, version: match?.[1] };
}

export function cmdCheck(sub: string, _args: string[]): void {
  if (sub !== "tools") {
    console.log(`unknown subcommand: ${sub}`);
    console.log("usage: maw check [tools]");
    return;
  }

  const GREEN  = "\x1b[32m";
  const RED    = "\x1b[31m";
  const DIM    = "\x1b[90m";
  const RESET  = "\x1b[0m";

  const results: ToolStatus[] = TOOLS.map(t => ({ ...t, ...checkTool(t.name) }));
  const reqResults  = results.filter(t => t.category === "required");
  const optResults  = results.filter(t => t.category === "optional");
  const missing     = results.filter(t => !t.present);

  console.log("\nmaw check tools\n");

  console.log("Required:");
  for (const t of reqResults) {
    if (t.present) {
      const ver = t.version ? `  ${t.version}` : "";
      console.log(`  ${GREEN}✓${RESET} ${t.name.padEnd(8)}${ver}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${t.name.padEnd(8)}  ${DIM}not installed${RESET}`);
    }
  }

  console.log("\nOptional (Python plugins):");
  for (const t of optResults) {
    if (t.present) {
      const ver   = t.version ? `  ${t.version}` : "";
      const notes = t.notes ? `  ${DIM}(${t.notes})${RESET}` : "";
      console.log(`  ${GREEN}✓${RESET} ${t.name.padEnd(8)}${ver}${notes}`);
    } else {
      console.log(`  ${RED}✗${RESET} ${t.name.padEnd(8)}  ${DIM}not installed${RESET}`);
    }
  }

  if (missing.length > 0) {
    console.log("\nMissing:");
    for (const t of missing) {
      console.log(`  ${RED}✗${RESET} ${t.name.padEnd(16)}  ${tlink(t.installUrl)}`);
    }
  }

  const reqOk  = reqResults.filter(t => t.present).length;
  const optOk  = optResults.filter(t => t.present).length;
  const misStr = missing.length > 0
    ? `${RED}${missing.length} missing${RESET}`
    : "0 missing";

  console.log(`\n${reqOk} required ✓  ·  ${optOk} optional ✓  ·  ${misStr}`);
  console.log();
}
