#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type Counts = { linesFound: number; linesHit: number; funcsFound: number; funcsHit: number };

type Badge = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
};

const cwd = realpathSync(process.cwd());
const lcovPath = process.argv[2] || "coverage/lcov.info";
const outPath = process.argv[3] || "coverage/maw-js-coverage.json";

function relPath(file: string): string {
  const realFile = existsSync(file) ? realpathSync(file) : file;
  const normalized = realFile.replaceAll("\\", "/");
  const normalizedCwd = cwd.replaceAll("\\", "/");
  const rel = normalized.startsWith(normalizedCwd) ? relative(cwd, normalized).replaceAll("\\", "/") : normalized;
  return rel.replace(/^\.\//, "");
}

function countSourceLines(file: string): number {
  const text = readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*");
  }).length;
}

function walkSource(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "coverage") continue;
      walkSource(full, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function parseLcov(path: string): Map<string, Counts> {
  if (!existsSync(path)) throw new Error(`coverage lcov not found: ${path}`);
  const files = new Map<string, Counts>();
  for (const record of readFileSync(path, "utf8").split("end_of_record")) {
    const lines = record.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const source = lines.find((line) => line.startsWith("SF:"));
    if (!source) continue;
    const file = relPath(source.slice(3));
    if (!file.startsWith("src/") || !/\.tsx?$/.test(file) || file.endsWith(".d.ts") || file.endsWith(".test.ts")) continue;

    const counts: Counts = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
    const lineHits = new Map<number, number>();
    for (const line of lines) {
      if (line.startsWith("DA:")) {
        const [lineNo, hits] = line.slice(3).split(",").map(Number);
        if (Number.isFinite(lineNo) && Number.isFinite(hits)) lineHits.set(lineNo, hits);
      } else if (line.startsWith("LF:")) counts.linesFound = Number(line.slice(3)) || 0;
      else if (line.startsWith("LH:")) counts.linesHit = Number(line.slice(3)) || 0;
      else if (line.startsWith("FNF:")) counts.funcsFound = Number(line.slice(4)) || 0;
      else if (line.startsWith("FNH:")) counts.funcsHit = Number(line.slice(4)) || 0;
    }
    if (counts.linesFound === 0 && lineHits.size > 0) {
      counts.linesFound = lineHits.size;
      counts.linesHit = [...lineHits.values()].filter((hits) => hits > 0).length;
    }
    files.set(file, counts);
  }
  return files;
}

function add(into: Counts, from: Counts): void {
  into.linesFound += from.linesFound;
  into.linesHit += from.linesHit;
  into.funcsFound += from.funcsFound;
  into.funcsHit += from.funcsHit;
}

function pct(hit: number, found: number): number {
  return found ? (hit / found) * 100 : 0;
}

function colorFor(percent: number): string {
  if (percent < 50) return "red";
  if (percent < 70) return "yellow";
  if (percent < 90) return "green";
  return "brightgreen";
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

const files = parseLcov(lcovPath);
for (const abs of walkSource("src")) {
  const file = relPath(abs);
  if (files.has(file)) continue;
  files.set(file, { linesFound: countSourceLines(abs), linesHit: 0, funcsFound: 0, funcsHit: 0 });
}

const overall: Counts = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
for (const counts of files.values()) add(overall, counts);

const functionPercent = pct(overall.funcsHit, overall.funcsFound);
const linePercent = pct(overall.linesHit, overall.linesFound);
const badge: Badge = {
  schemaVersion: 1,
  label: "coverage",
  message: `${formatPercent(functionPercent)} functions`,
  color: colorFor(functionPercent),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`coverage badge: ${badge.message}, ${formatPercent(linePercent)} lines → ${outPath}`);
