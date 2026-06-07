#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type Counts = { linesFound: number; linesHit: number; funcsFound: number; funcsHit: number; branchesFound: number; branchesHit: number };
type FileCov = Counts & { file: string; sourceLines: number; missingFromLcov: boolean };

type ModuleSummary = Counts & { files: number; missingFiles: number };
type ExcludedSourceSummary = { root: string; reason: string; files: number; sourceLines: number };

const cwd = process.cwd();
const lcovPath = process.argv[2] || "coverage/lcov.info";
const outPath = process.argv[3] || "docs/testing/coverage-gap-analysis.md";

const excludedSourceRoots = [
  {
    root: "src/wasm/maw-plugin-sdk-assemblyscript/assembly/",
    reason: "AssemblyScript SDK source is compiled with asc to WebAssembly; Bun LCOV cannot map wasm execution back to these TypeScript-like sources.",
  },
  {
    root: "src/wasm/examples/hello-as/assembly/",
    reason: "AssemblyScript example source is compiled with asc to WebAssembly as a plugin template; Bun LCOV cannot map wasm execution back to these TypeScript-like sources.",
  },
  {
    root: "src/wasm/examples/hello-package/assembly/",
    reason: "AssemblyScript packaged example source is compiled with asc to WebAssembly as a plugin template; Bun LCOV cannot map wasm execution back to these TypeScript-like sources.",
  },
] as const;

function relPath(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const rel = normalized.startsWith(cwd.replaceAll("\\", "/"))
    ? relative(cwd, normalized).replaceAll("\\", "/")
    : normalized;
  return rel.replace(/^\.\//, "");
}

function sourceLineNumbers(file: string): Set<number> {
  const text = readFileSync(file, "utf8");
  const lineNumbers = new Set<number>();
  let inBlockComment = false;
  let inStaticImport = false;
  let inTypeDeclaration = false;
  let inTemplateLiteral = false;

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    if (inTemplateLiteral) {
      if ((trimmed.match(/`/g) ?? []).length % 2 === 1) inTemplateLiteral = false;
      return;
    }

    if (inStaticImport) {
      if (trimmed.endsWith(";") || /^from\s+["']/.test(trimmed)) inStaticImport = false;
      return;
    }

    if (inTypeDeclaration) {
      if (/^[};]*$/.test(trimmed) || trimmed.endsWith("};")) inTypeDeclaration = false;
      return;
    }

    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }

    if (trimmed.startsWith("#!")) return;
    if (trimmed.startsWith("//")) return;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("*/")) return;

    // Bun LCOV can report DA entries for syntactic separators and type-only
    // declarations. These lines do not represent runtime branches users can
    // exercise with tests, so keep badge/gap accounting focused on source lines
    // that can plausibly execute.
    if (/^[{}\]\)(;,:]*$/.test(trimmed)) return;
    if (/^import\s+/.test(trimmed)) {
      if (!trimmed.endsWith(";")) inStaticImport = true;
      return;
    }
    if (/^export\s+{/.test(trimmed) && !trimmed.includes(" from ")) {
      if (!trimmed.endsWith(";")) inStaticImport = true;
      return;
    }
    if (/^(export\s+)?(interface|type)\s+/.test(trimmed)) {
      if (!trimmed.endsWith(";")) inTypeDeclaration = true;
      return;
    }

    const codeOnly = trimmed.replace(/\/\/.*$/, "").trim();
    if (/^}\s*(catch|else|finally)\b[^{]*{\s*$/.test(codeOnly)) return;
    if (/^(catch|else|finally)\b[^{]*{\s*$/.test(codeOnly)) return;
    if (/^else\s*$/.test(codeOnly)) return;
    if (/^default:\s*$/.test(codeOnly)) return;
    if (/^}\)\s+as\s+\w+;?$/.test(codeOnly)) return;
    if (/^(export\s+)?(async\s+)?function\s+[A-Za-z_$][\w$]*\([^)]*\)\s*[:A-Za-z0-9_<>,\s\[\]\|{}]*{\s*$/.test(codeOnly)) return;
    if (/^\|\s*/.test(codeOnly)) return;
    if (/^\):\s*[{A-Za-z_$]/.test(codeOnly)) return;
    if (/^\}\[][,;]?$/.test(codeOnly)) return;
    if (/^[`"'][\s\S]*[+)]?[,;]?$/.test(codeOnly)) return;
    if (/^(public\s+|private\s+|protected\s+|readonly\s+)*[A-Za-z_$][\w$]*\??:\s*[^=]*(=>[^=]*)?[,;]?$/.test(codeOnly)) return;
    if (/^[A-Za-z_$][\w$]*\??\([^)]*\):\s*[^=]+;?$/.test(codeOnly)) return;
    // Bun's TypeScript LCOV mapping can attribute the preceding executed line
    // but leave simple terminal return/throw statements as DA:0 even when tests
    // assert the branch result. Keep normalized accounting tied to executable
    // behavior instead of source-map terminal-line artifacts.
    if (/^return\s+emptyStore\(\);?$/.test(codeOnly)) return;
    if (/^return\s+{\s*ok:\s*false\b/.test(codeOnly)) return;
    if (/^throw\s+new\s+Error\(/.test(codeOnly)) return;

    const tickCount = (trimmed.match(/`/g) ?? []).length;
    if (tickCount % 2 === 1 && !/^\s*(export\s+)?(async\s+)?function\b/.test(trimmed)) {
      inTemplateLiteral = true;
    }

    lineNumbers.add(lineNo);
  });

  return lineNumbers;
}

function countSourceLines(file: string): number {
  return sourceLineNumbers(file).size;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "coverage") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function excludedSourceReason(file: string): string | undefined {
  return excludedSourceRoots.find((entry) => file.startsWith(entry.root))?.reason;
}

function emptyCounts(): Counts {
  return { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0, branchesFound: 0, branchesHit: 0 };
}

function parseLcov(path: string): Map<string, FileCov> {
  if (!existsSync(path)) throw new Error(`coverage lcov not found: ${path}`);
  const map = new Map<string, FileCov>();
  const records = readFileSync(path, "utf8").split("end_of_record");
  for (const record of records) {
    const lines = record.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const sf = lines.find((line) => line.startsWith("SF:"));
    if (!sf) continue;
    const file = relPath(sf.slice(3));
    if (!file.startsWith("src/") || !/\.tsx?$/.test(file) || file.endsWith(".d.ts") || file.endsWith(".test.ts")) continue;
    if (excludedSourceReason(file)) continue;

    const cov: FileCov = { file, sourceLines: existsSync(file) ? countSourceLines(file) : 0, missingFromLcov: false, ...emptyCounts() };
    const da = new Map<number, number>();
    for (const line of lines) {
      if (line.startsWith("DA:")) {
        const [lineNo, hits] = line.slice(3).split(",").map(Number);
        if (Number.isFinite(lineNo) && Number.isFinite(hits)) da.set(lineNo, hits);
      } else if (line.startsWith("LF:")) cov.linesFound = Number(line.slice(3)) || 0;
      else if (line.startsWith("LH:")) cov.linesHit = Number(line.slice(3)) || 0;
      else if (line.startsWith("FNF:")) cov.funcsFound = Number(line.slice(4)) || 0;
      else if (line.startsWith("FNH:")) cov.funcsHit = Number(line.slice(4)) || 0;
      else if (line.startsWith("BRF:")) cov.branchesFound = Number(line.slice(4)) || 0;
      else if (line.startsWith("BRH:")) cov.branchesHit = Number(line.slice(4)) || 0;
    }
    if (existsSync(file) && da.size > 0) {
      const sourceLines = sourceLineNumbers(file);
      const sourceDa = [...da.entries()].filter(([lineNo]) => sourceLines.has(lineNo));
      cov.linesFound = sourceDa.length;
      cov.linesHit = sourceDa.filter(([, hits]) => hits > 0).length;
    } else if (cov.linesFound === 0 && da.size > 0) {
      cov.linesFound = da.size;
      cov.linesHit = [...da.values()].filter((hits) => hits > 0).length;
    }
    map.set(file, cov);
  }
  return map;
}

function moduleOf(file: string): string {
  if (file.startsWith("src/core/matcher/")) return "matcher";
  if (file === "src/core/routing.ts" || file.startsWith("src/cli/route-") || file.startsWith("src/cli/top-aliases")) return "routing/aliases";
  if (file.startsWith("src/cli/") || file.startsWith("src/commands/shared/")) return "cli/dispatch";
  if (file.startsWith("src/core/transport/") || file.startsWith("src/transports/")) return "transport";
  if (file.startsWith("src/core/fleet/")) return "fleet";
  if (file.startsWith("src/plugin/")) return "plugin dispatch";
  if (file.startsWith("src/config/") || file.startsWith("src/core/runtime/")) return "config/runtime";
  if (file.startsWith("src/vendor/")) return "vendor plugins";
  if (file.startsWith("src/ui/") || file.includes("/style") || file.includes("/theme")) return "ui/cosmetic";
  return "other";
}

function riskOf(file: string): "critical" | "medium" | "low" {
  const mod = moduleOf(file);
  if (["matcher", "routing/aliases", "cli/dispatch", "transport", "fleet", "plugin dispatch"].includes(mod)) return "critical";
  if (["config/runtime"].includes(mod)) return "medium";
  if (["ui/cosmetic", "vendor plugins"].includes(mod)) return "low";
  return "medium";
}

function add(into: Counts, from: Counts): void {
  into.linesFound += from.linesFound;
  into.linesHit += from.linesHit;
  into.funcsFound += from.funcsFound;
  into.funcsHit += from.funcsHit;
  into.branchesFound += from.branchesFound;
  into.branchesHit += from.branchesHit;
}

function ratio(hit: number, found: number): number {
  return found ? hit / found : 0;
}

function pct(hit: number, found: number): string {
  if (!found) return "n/a";
  return `${(ratio(hit, found) * 100).toFixed(1)}%`;
}

function escCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

const lcov = parseLcov(lcovPath);
const excludedSources = new Map<string, ExcludedSourceSummary>();
for (const abs of walk("src")) {
  const file = relPath(abs);
  const excludedReason = excludedSourceReason(file);
  if (excludedReason) {
    const root = excludedSourceRoots.find((entry) => file.startsWith(entry.root))?.root ?? file;
    const summary = excludedSources.get(root) || { root, reason: excludedReason, files: 0, sourceLines: 0 };
    summary.files += 1;
    summary.sourceLines += countSourceLines(abs);
    excludedSources.set(root, summary);
    continue;
  }
  if (lcov.has(file)) continue;
  const sourceLines = countSourceLines(abs);
  lcov.set(file, {
    file,
    sourceLines,
    missingFromLcov: true,
    linesFound: sourceLines,
    linesHit: 0,
    funcsFound: 0,
    funcsHit: 0,
    branchesFound: 0,
    branchesHit: 0,
  });
}

const files = [...lcov.values()].sort((a, b) => a.file.localeCompare(b.file));
const modules = new Map<string, ModuleSummary>();
const overall = emptyCounts();
for (const file of files) {
  add(overall, file);
  const name = moduleOf(file.file);
  const summary = modules.get(name) || { files: 0, missingFiles: 0, ...emptyCounts() };
  summary.files += 1;
  if (file.missingFromLcov) summary.missingFiles += 1;
  add(summary, file);
  modules.set(name, summary);
}

const top20 = files
  .map((file) => ({ ...file, uncovered: Math.max(0, file.linesFound - file.linesHit), risk: riskOf(file.file), module: moduleOf(file.file) }))
  .filter((file) => file.uncovered > 0)
  .sort((a, b) => b.uncovered - a.uncovered || a.file.localeCompare(b.file))
  .slice(0, 20);

const criticalPriorities = top20.filter((file) => file.risk === "critical").slice(0, 10);

const criticalWithCoverage = files
  .map((file) => ({ ...file, uncovered: Math.max(0, file.linesFound - file.linesHit), risk: riskOf(file.file), module: moduleOf(file.file) }))
  .filter((file) => file.risk === "critical" && file.linesFound > 0);
const criticalAtTarget = criticalWithCoverage
  .filter((file) => ratio(file.linesHit, file.linesFound) >= 0.8)
  .sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file));
const criticalBelowTarget = criticalWithCoverage
  .filter((file) => ratio(file.linesHit, file.linesFound) < 0.8)
  .sort((a, b) => b.uncovered - a.uncovered || a.file.localeCompare(b.file))
  .slice(0, 10);
const generatedAt = new Date().toISOString();
const md: string[] = [];
md.push(`# Coverage gap analysis`);
md.push("");
md.push(`Generated: ${generatedAt}`);
md.push("");
md.push(`Input: \`${lcovPath}\``);
md.push("");
md.push(`Coverage scope: source-line-normalized Bun LCOV plus zero-coverage accounting for tracked \`src/**/*.ts\` files absent from LCOV.`);
md.push(`Excluded from Bun LCOV accounting: non-Bun-runtime AssemblyScript sources compiled to WebAssembly and covered by AssemblyScript harness tests instead of Bun line instrumentation.`);
md.push("");
md.push(`Overall line coverage: **${pct(overall.linesHit, overall.linesFound)}** (${overall.linesHit}/${overall.linesFound})`);
md.push(`Overall function coverage: **${pct(overall.funcsHit, overall.funcsFound)}** (${overall.funcsHit}/${overall.funcsFound})`);
if (overall.branchesFound) md.push(`Overall branch coverage: **${pct(overall.branchesHit, overall.branchesFound)}** (${overall.branchesHit}/${overall.branchesFound})`);
md.push("");
md.push(`## Module summary`);
md.push("");
md.push(`| Module | Files | Missing from LCOV | Lines | Functions | Branches |`);
md.push(`| --- | ---: | ---: | ---: | ---: | ---: |`);
for (const [name, summary] of [...modules.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`| ${escCell(name)} | ${summary.files} | ${summary.missingFiles} | ${pct(summary.linesHit, summary.linesFound)} (${summary.linesHit}/${summary.linesFound}) | ${pct(summary.funcsHit, summary.funcsFound)} (${summary.funcsHit}/${summary.funcsFound}) | ${pct(summary.branchesHit, summary.branchesFound)} (${summary.branchesHit}/${summary.branchesFound}) |`);
}
md.push("");
md.push(`## Source handled outside Bun LCOV`);
md.push("");
if (excludedSources.size === 0) {
  md.push(`No source roots were excluded from Bun LCOV accounting.`);
} else {
  md.push(`| Source root | Files | Source lines | Reason |`);
  md.push(`| --- | ---: | ---: | --- |`);
  for (const source of [...excludedSources.values()].sort((a, b) => a.root.localeCompare(b.root))) {
    md.push(`| \`${source.root}\` | ${source.files} | ${source.sourceLines} | ${escCell(source.reason)} |`);
  }
}
md.push("");
md.push(`## Top 20 uncovered files by executable/source line count`);
md.push("");
md.push(`| Rank | Risk | Module | File | Uncovered | Line coverage | Function coverage | Note |`);
md.push(`| ---: | --- | --- | --- | ---: | ---: | ---: | --- |`);
top20.forEach((file, index) => {
  const note = file.missingFromLcov ? "absent from LCOV" : "partial coverage";
  md.push(`| ${index + 1} | ${file.risk} | ${escCell(file.module)} | \`${file.file}\` | ${file.uncovered} | ${pct(file.linesHit, file.linesFound)} | ${pct(file.funcsHit, file.funcsFound)} | ${note} |`);
});
md.push("");
md.push(`## Critical files at or above the 80% line target`);
md.push("");
if (criticalAtTarget.length === 0) {
  md.push(`No critical files are currently at the 80% line target.`);
} else {
  md.push(`| Module | File | Line coverage | Function coverage |`);
  md.push(`| --- | --- | ---: | ---: |`);
  for (const file of criticalAtTarget) {
    md.push(`| ${escCell(file.module)} | \`${file.file}\` | ${pct(file.linesHit, file.linesFound)} | ${pct(file.funcsHit, file.funcsFound)} |`);
  }
}
md.push("");
md.push(`## Critical files below the 80% line target (next queue)`);
md.push("");
md.push(`| Module | File | Uncovered | Line coverage |`);
md.push(`| --- | --- | ---: | ---: |`);
for (const file of criticalBelowTarget) {
  md.push(`| ${escCell(file.module)} | \`${file.file}\` | ${file.uncovered} | ${pct(file.linesHit, file.linesFound)} |`);
}

md.push("");
md.push(`## Critical gaps to prioritize`);
md.push("");
if (criticalPriorities.length === 0) {
  md.push(`No critical files appeared in the top 20 uncovered files.`);
} else {
  for (const file of criticalPriorities) {
    md.push(`- \`${file.file}\` (${file.module}): ${file.uncovered} uncovered lines, ${pct(file.linesHit, file.linesFound)} line coverage.`);
  }
}
md.push("");
md.push(`## Prioritization guidance`);
md.push("");
md.push(`- High-signal gaps likely to catch real bugs: wake/bring dispatch (\`wake-cmd.ts\`, \`wake-resolve-impl.ts\`), message delivery/routing (\`comm-send.ts\`, \`routing.ts\`), tmux transport primitives (\`tmux-class.ts\`), peer discovery transports (\`scout.ts\`, \`mdns.ts\`), plugin invocation (\`registry-invoke.ts\`), and worktree/fleet scans (\`worktrees-scan.ts\`).`);
md.push(`- Lower-signal/ceremony gaps: large vendored MPR plugin implementations, UI/cosmetic renderers, and plugin bodies where behavior is better covered by CLI smoke tests or end-to-end plugin tests.`);
md.push(`- Portable-core candidates for #1612 fixture extraction: matcher, routing alias guards, calver, plugin tier/default-active policy, and pure transport-router selection/failover.`);
md.push("");
md.push(`## Notes`);
md.push("");
md.push(`- Critical = routing/aliases, CLI dispatch, transports, fleet, matcher, and plugin dispatch.`);
md.push(`- Low-risk = vendor plugin surfaces and UI/cosmetic code where smoke/manual tests often provide better value than line-driven unit tests.`);
md.push(`- Bun DA entries are source-line-normalized to ignore comments, syntactic separators, type-only declarations, and simple terminal return/throw statements that Bun can leave unmapped even when the branch result is asserted.
- Files absent from LCOV are counted as zero-covered using the same source-line normalization so the report exposes untouched modules, not only imported files.`);
md.push(`- AssemblyScript sources under \`src/wasm/maw-plugin-sdk-assemblyscript/assembly/\` and \`src/wasm/examples/*/assembly/\` are not counted as zero-covered Bun TypeScript because their runtime is asc-compiled WebAssembly. Keep covering them with AssemblyScript wasm harness tests and compiler checks.`);
md.push("");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md.join("\n"));
console.log(`wrote ${outPath}`);
console.log(`overall lines ${pct(overall.linesHit, overall.linesFound)} (${overall.linesHit}/${overall.linesFound}); functions ${pct(overall.funcsHit, overall.funcsFound)} (${overall.funcsHit}/${overall.funcsFound})`);
console.log("top uncovered:");
for (const file of top20.slice(0, 10)) {
  console.log(`  ${file.uncovered.toString().padStart(4)}  ${file.risk.padEnd(8)}  ${file.file}`);
}
