#!/usr/bin/env bun
/**
 * check-redos.ts — pre-commit ReDoS detector (#823 follow-up).
 *
 * Catches polynomial-backtracking regex patterns BEFORE push so we don't
 * eat a 5-min CI round-trip on CodeQL js/polynomial-redos alerts.
 *
 * SCOPE: high-confidence patterns only. CodeQL is the safety net; this is
 * the early-warn. Bias: false negatives over false positives.
 *
 * PATTERNS DETECTED (high severity → exit 1):
 *   A. `/[charclass]+$/` un-anchored to `^` — char class with `+` or `*`
 *      anchored to END only. Backtracks because the engine can begin matching
 *      at any offset. This is the exact shape we hit in #823 (`[-.]+$`).
 *      FIX: anchor with `^...$`, OR prepend `(?<![charclass])` look-behind.
 *
 *   B. `/(a|b|c)[+*]/` — alternation with unbounded quantifier. Each branch
 *      can match overlapping input → exponential backtracking on failure.
 *      FIX: factor out the alternation, or use atomic groups.
 *
 *   D. `/(.[+*])[+*]/` — nested unbounded quantifiers, e.g. `(.+)+`, `(.*)*`.
 *      Classic catastrophic backtracking. FIX: collapse to single quantifier.
 *
 * PATTERNS WARNED (info only → never fails):
 *   C. `new RegExp(<dynamic>)` — dynamic regex from concat / template. Make
 *      sure the source is escaped (e.g. `s.replace(/[.*+?^${}()|[\]\\]/g,…)`).
 *
 * ESCAPE HATCH: a line ending with `// CODEQL_OK` (or anywhere on the line)
 * is skipped. Use ONLY for verified-safe regexes — leave a short reason.
 *
 *   Example: `.replace(/[-.]+$/, "")  // CODEQL_OK: input length-capped to 50`
 *
 * RELATIONSHIP TO CI: GitHub CodeQL still runs on every PR and is the
 * authoritative gate. This script just catches the obvious cases earlier.
 *
 * USAGE:
 *   bun scripts/check-redos.ts            # scan src/, exit 1 on high-sev
 *   bun scripts/check-redos.ts <files…>   # scan specific files (hook mode)
 */

import { Glob } from "bun";
import { readFileSync } from "fs";

type Severity = "high" | "info";
type Hit = { file: string; line: number; rule: string; severity: Severity; excerpt: string; fix: string };

const ESCAPE_RE = /\/\/\s*CODEQL_OK\b/;

// Match a JS regex literal: `/pattern/flags`. Conservative — won't catch
// every literal, but catches the common assignment / replace / test forms.
// Group 1 = pattern body (no slashes). False negatives are acceptable.
//
// Branches MUST start with disjoint characters to avoid the polynomial
// backtracking shape this script itself flags (CodeQL js/redos):
//   1. `\\.`              — escape sequence (starts with `\`)
//   2. `\[[^\]]*\]`       — char class (starts with `[`)
//   3. `[^/\n\\[]`        — single safe char (starts with anything ELSE)
const REGEX_LITERAL = /\/((?:\\.|\[[^\]]*\]|[^/\n\\[])+)\/[gimsuy]*/g;

// Pattern A: POSITIVE char-class + `+`/`*` anchored to `$`, no leading `^`,
// no protective look-behind. Negated classes (`[^…]`) are excluded — their
// match boundary is unambiguous, so CodeQL doesn't flag them and neither do we.
// This is the exact shape that hit us in #823 (`[-.]+$`).
function checkPatternA(body: string): boolean {
  if (body.startsWith("^")) return false;
  if (/\(\?<[!=]/.test(body)) return false;
  // Trailing `[…]+$` or `[…]*$` where the class is POSITIVE (no leading ^).
  const m = body.match(/\[([^\]]*)\][+*]\$$/);
  if (!m) return false;
  if (m[1].startsWith("^")) return false;  // negated → safe
  // Single contiguous range like `[0-9]` or `[a-z]` — CodeQL doesn't flag
  // these, and they're bounded by typical input lengths in our codebase.
  if (/^\\?[a-zA-Z0-9]-\\?[a-zA-Z0-9]$/.test(m[1])) return false;
  return true;
}

// Pattern B: alternation with unbounded quantifier, e.g. `(a|b)+`. We only
// flag when the regex isn't anchored (^…) — anchored alternation is bounded
// by the input start. We also require that branches are TRIVIAL (no nested
// groups / quantifiers) to avoid false-positives on non-overlapping cases.
function checkPatternB(body: string): boolean {
  if (body.startsWith("^")) return false;
  const m = body.match(/\(\??:?([^()|]*\|[^()|]*)\)[+*]/);
  if (!m) return false;
  // Skip if any branch contains a quantifier (already structured).
  if (/[+*?]/.test(m[1])) return false;
  return true;
}

// Pattern D: nested unbounded quantifiers — `(.+)+`, `(.*)*`, `(\w+)+`, etc.
function checkPatternD(body: string): boolean {
  return /\([^()]*[+*]\)[+*]/.test(body);
}

// Pattern C (info): `new RegExp(<dynamic>)` — concat or template.
const NEW_REGEXP_DYN = /\bnew\s+RegExp\s*\(\s*[`"']?[^)"'`]*[`+$]/;

function scan(file: string): Hit[] {
  const hits: Hit[] = [];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ESCAPE_RE.test(line)) continue;
    // Skip pure comment lines — don't false-positive on docstring examples.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    REGEX_LITERAL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REGEX_LITERAL.exec(line))) {
      const body = m[1];
      const excerpt = m[0];
      if (checkPatternA(body)) {
        hits.push({ file, line: i + 1, rule: "A:char-class+$", severity: "high", excerpt,
          fix: "Anchor with ^...$ OR prefix `(?<![charclass])` look-behind." });
      }
      if (checkPatternD(body)) {
        hits.push({ file, line: i + 1, rule: "D:nested-quant", severity: "high", excerpt,
          fix: "Collapse nested quantifiers — `(.+)+` → `.+`." });
      }
      if (checkPatternB(body)) {
        hits.push({ file, line: i + 1, rule: "B:alt+quant", severity: "high", excerpt,
          fix: "Factor alternation out of the quantifier, or use atomic groups." });
      }
    }
    if (NEW_REGEXP_DYN.test(line)) {
      hits.push({ file, line: i + 1, rule: "C:new-RegExp", severity: "info", excerpt: line.trim(),
        fix: "Verify the source is escaped (regex-quote user input)." });
    }
  }
  return hits;
}

async function main() {
  const argv = process.argv.slice(2);
  let files: string[];
  if (argv.length > 0) {
    files = argv.filter(f => f.endsWith(".ts") && !f.includes("node_modules"));
  } else {
    const glob = new Glob("src/**/*.ts");
    files = [];
    for await (const f of glob.scan(".")) {
      if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".d.ts")) continue;
      files.push(f);
    }
  }

  const allHits: Hit[] = [];
  for (const f of files) {
    try { allHits.push(...scan(f)); } catch { /* unreadable — skip */ }
  }

  const high = allHits.filter(h => h.severity === "high");
  const info = allHits.filter(h => h.severity === "info");

  for (const h of high) {
    console.error(`✗ ${h.file}:${h.line} [${h.rule}] ${h.excerpt}`);
    console.error(`  fix: ${h.fix}`);
  }
  if (info.length > 0 && (process.env.REDOS_VERBOSE || high.length > 0)) {
    for (const h of info) {
      console.error(`◌ ${h.file}:${h.line} [${h.rule}] ${h.excerpt}`);
      console.error(`  note: ${h.fix}`);
    }
  }

  if (high.length > 0) {
    console.error(`\n✗ check-redos: ${high.length} high-severity ReDoS pattern(s) in ${files.length} file(s).`);
    console.error(`  Add \`// CODEQL_OK: <reason>\` to the line ONLY if you've verified it's safe.`);
    process.exit(1);
  }
  console.log(`✓ check-redos: 0 high-severity in ${files.length} file(s)${info.length ? ` (${info.length} dynamic-RegExp note${info.length === 1 ? "" : "s"})` : ""}.`);
}

main();
