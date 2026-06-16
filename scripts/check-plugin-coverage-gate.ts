#!/usr/bin/env bun
/**
 * check-plugin-coverage-gate.ts — PR guardrail for #2316.
 *
 * Problem: vendor plugin extractions repeatedly move runtime imports from
 * core/shared/config internals to the SDK boundary, then old implementation
 * coverage tests break until their mocks are realigned. This gate makes that
 * coupling explicit: when a PR changes a vendor plugin or the SDK boundary, it
 * must also update the matching standalone-boundary tests/pattern.
 *
 * Usage:
 *   bun scripts/check-plugin-coverage-gate.ts origin/alpha
 *   bun scripts/check-plugin-coverage-gate.ts --files <changed-file>...
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const STANDALONE_TEST_RE = /^test\/isolated\/plugin-[^/]+-standalone\.test\.ts$/;
const BOUNDARY_PATTERN_FILES = new Set([
  "test/isolated/helpers/plugin-standalone-boundary.ts",
  "scripts/check-plugin-coverage-gate.ts",
]);

type GateResult = {
  ok: boolean;
  pluginChanges: Map<string, string[]>;
  sdkChanges: string[];
  testChanges: string[];
  failures: string[];
};

function runGit(args: string[]): string {
  const proc = spawnSync("git", args, { encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`.trim());
  }
  return proc.stdout.trim();
}

function changedFilesFromGit(baseRef?: string): string[] {
  const base = baseRef || process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}` || "origin/alpha";
  const mergeBase = runGit(["merge-base", base, "HEAD"]);
  const committed = runGit(["diff", "--name-only", `${mergeBase}...HEAD`]);
  const unstaged = runGit(["diff", "--name-only"]);
  const staged = runGit(["diff", "--cached", "--name-only"]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([committed, staged, unstaged, untracked]
    .flatMap((output) => output.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean))];
}

function isRuntimeSource(path: string): boolean {
  return /\.(?:ts|tsx|js|json)$/.test(path) && !path.endsWith(".d.ts");
}

function standaloneTestFor(plugin: string): string {
  return `test/isolated/plugin-${plugin}-standalone.test.ts`;
}

function analyzeChangedFiles(files: string[]): GateResult {
  const pluginChanges = new Map<string, string[]>();
  const pluginNonManifestChanges = new Set<string>();
  const pluginOnlyGeneratedChanges = new Set<string>();
  const sdkChanges: string[] = [];
  const testChanges = files.filter((file) => STANDALONE_TEST_RE.test(file) || BOUNDARY_PATTERN_FILES.has(file));
  const failures: string[] = [];

  for (const file of files) {
    if (!isRuntimeSource(file)) continue;

    const pluginMatch = file.match(/^src\/(?:vendor\/mpr-plugins|vendor-plugins)\/([^/]+)\//);
    if (pluginMatch) {
      const plugin = pluginMatch[1];
      if (!pluginChanges.has(plugin)) pluginChanges.set(plugin, []);
      pluginChanges.get(plugin)!.push(file);
      const isPluginTs = /\/plugin\.ts$/.test(file);
      const isPluginJson = /\/plugin\.json$/.test(file);
      if (!isPluginTs) {
        pluginNonManifestChanges.add(plugin);
      } else if (!isPluginJson) {
        pluginOnlyGeneratedChanges.add(plugin);
      }
      continue;
    }

    if (file.startsWith("src/sdk/") || file === "src/sdk.ts") {
      sdkChanges.push(file);
    }
  }

  for (const [plugin, changed] of pluginChanges) {
    const onlyGeneratedFiles = changed.length > 0
      && changed.every((file) => /\/plugin\.ts$/.test(file));
    if (onlyGeneratedFiles && !pluginNonManifestChanges.has(plugin)) {
      continue;
    }

    if (!pluginNonManifestChanges.has(plugin) && pluginOnlyGeneratedChanges.has(plugin) && changed.length > 0) {
      continue;
    }

    const test = standaloneTestFor(plugin);
    if (!existsSync(test)) {
      failures.push(
        `${plugin}: changed ${changed.length} vendor file(s) but ${test} does not exist. ` +
        `Add the standalone boundary test instead of relying on brittle implementation coverage mocks.`,
      );
      continue;
    }
    if (!files.includes(test) && !testChanges.some((file) => BOUNDARY_PATTERN_FILES.has(file))) {
      failures.push(
        `${plugin}: changed ${changed.length} vendor file(s) without updating ${test}. ` +
        `If behavior is unchanged, refresh the boundary assertion/import mocks so extraction drift is explicit.`,
      );
    }
  }

  if (sdkChanges.length > 0 && testChanges.length === 0) {
    failures.push(
      `SDK boundary changed (${sdkChanges.join(", ")}) without any plugin standalone-boundary test or helper update. ` +
      `Update at least one test/isolated/plugin-*-standalone.test.ts or the boundary helper so SDK mock drift is covered.`,
    );
  }

  return { ok: failures.length === 0, pluginChanges, sdkChanges, testChanges, failures };
}

function printSummary(result: GateResult, files: string[]): void {
  console.log(`plugin coverage gate: ${files.length} changed file(s)`);
  if (result.pluginChanges.size > 0) {
    console.log(`vendor plugins touched: ${[...result.pluginChanges.keys()].sort().join(", ")}`);
  }
  if (result.sdkChanges.length > 0) {
    console.log(`sdk boundary files touched: ${result.sdkChanges.join(", ")}`);
  }
  if (result.testChanges.length > 0) {
    console.log(`boundary tests/helpers touched: ${result.testChanges.join(", ")}`);
  }
}

function parseArgs(argv: string[]): { files?: string[]; base?: string } {
  if (argv[0] === "--files") return { files: argv.slice(1) };
  return { base: argv[0] };
}

if (import.meta.main) {
  const { files: explicitFiles, base } = parseArgs(process.argv.slice(2));
  const files = explicitFiles ?? changedFilesFromGit(base);
  const result = analyzeChangedFiles(files);
  printSummary(result, files);
  if (!result.ok) {
    console.error("\n✗ plugin coverage gate failed (#2316):");
    for (const failure of result.failures) console.error(`  - ${failure}`);
    console.error("\nFix: update/create the matching plugin-*-standalone.test.ts and use test/isolated/helpers/plugin-standalone-boundary.ts for import-boundary assertions.");
    process.exit(1);
  }
  console.log("✓ plugin coverage gate passed");
}

export { analyzeChangedFiles, changedFilesFromGit, standaloneTestFor };
