import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type ImportRecord = {
  spec: string;
  typeOnly: boolean;
};

type BoundaryOptions = {
  plugin: string;
  root?: string;
  pluginDir?: string;
  files?: string[];
  requireSdk?: boolean;
  allowMawJs?: Array<string | RegExp>;
  allowRelative?: Array<string | RegExp>;
};

const DEFAULT_ALLOWED_MAW_JS: Array<string | RegExp> = [
  "maw-js/sdk",
  /^maw-js\/plugin\/types$/,
  /^maw-js\/cli\/parse-args$/,
];

function repoRootFromTest(): string {
  return join(import.meta.dir, "../../..");
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function pluginSourceFiles(plugin: string, root = repoRootFromTest(), files?: string[]): string[] {
  const dir = join(root, "src/vendor/mpr-plugins", plugin);
  return files?.map((file) => join(dir, file)) ?? walkTsFiles(dir).sort();
}

function pluginSourceFilesFromOptions(options: BoundaryOptions): string[] {
  const root = options.root ?? repoRootFromTest();
  const dir = options.pluginDir
    ? join(root, options.pluginDir)
    : join(root, "src/vendor/mpr-plugins", options.plugin);
  return options.files?.map((file) => join(dir, file)) ?? walkTsFiles(dir).sort();
}

function parseImportRecords(source: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const staticImport = /\b(import|export)\s+(type\s+)?(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = staticImport.exec(source)) !== null) {
    records.push({ spec: match[3], typeOnly: Boolean(match[2]) });
  }
  while ((match = importFn.exec(source)) !== null) records.push({ spec: match[1], typeOnly: false });
  while ((match = requireFn.exec(source)) !== null) records.push({ spec: match[1], typeOnly: false });
  return records;
}

function matchesAny(value: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((pattern) => typeof pattern === "string" ? value === pattern : pattern.test(value));
}

function collectPluginImports(options: BoundaryOptions): ImportRecord[] {
  return pluginSourceFilesFromOptions(options)
    .flatMap((file) => parseImportRecords(readFileSync(file, "utf8")));
}

function expectStandalonePluginBoundary(options: BoundaryOptions): ImportRecord[] {
  const imports = collectPluginImports(options);
  const allowMawJs = [...DEFAULT_ALLOWED_MAW_JS, ...(options.allowMawJs ?? [])];
  const allowRelative = options.allowRelative ?? [];

  const forbiddenMawJs = imports
    .filter((record) => record.spec.startsWith("maw-js/"))
    .filter((record) => !record.typeOnly)
    .filter((record) => !matchesAny(record.spec, allowMawJs))
    .map((record) => record.spec);

  const forbiddenRelative = imports
    .filter((record) => /^(?:\.\.\/)+(?:core|commands|cli|config|lib|plugin|src)(?:\/|$)/.test(record.spec))
    .filter((record) => !matchesAny(record.spec, allowRelative))
    .map((record) => record.spec);

  expect(forbiddenMawJs).toEqual([]);
  expect(forbiddenRelative).toEqual([]);
  if (options.requireSdk ?? true) {
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
  }
  return imports;
}

export {
  collectPluginImports,
  expectStandalonePluginBoundary,
  parseImportRecords,
  pluginSourceFiles,
};
