import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

export interface DeprecatedTerm {
  pattern: RegExp;
  word: string;
  replacement: string;
  section: string;
}

export interface Violation {
  file: string;
  line: number;
  column: number;
  text: string;
  word: string;
  replacement: string;
}

export interface VerifyResult {
  violations: number;
  files: number;
  clean: number;
}

export interface VerifyOpts {
  paths?: string[];
  glossaryPath?: string;
  fix?: boolean;
  json?: boolean;
}

const DEFAULT_PATHS = ["ψ/", ".claude/"];
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".db", ".sqlite"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor"]);

const BUILT_IN_RULES: DeprecatedTerm[] = [
  {
    pattern: /\breincarnate[ds]?\b/gi,
    word: "reincarnate",
    replacement: "restart",
    section: "§3",
  },
  {
    pattern: /\breincarnation\b/gi,
    word: "reincarnation",
    replacement: "restart",
    section: "§3",
  },
  {
    pattern: /\brebirth\b/gi,
    word: "rebirth",
    replacement: "restart (or migration/bud depending on context)",
    section: "§5",
  },
  {
    pattern: /\breborn\b/gi,
    word: "reborn",
    replacement: "restarted (or migrated/budded)",
    section: "§5",
  },
  {
    pattern: /\bnew life\b/gi,
    word: "new life",
    replacement: "restart (or bud if new entity)",
    section: "§4",
  },
];

function parseGlossary(content: string): DeprecatedTerm[] {
  const terms: DeprecatedTerm[] = [];
  const sections = content.split(/(?=^## \d+\.)/m);
  for (const section of sections) {
    const headerMatch = section.match(/^## \d+\.\s+`(\w+)`/);
    if (!headerMatch) continue;
    if (!/\*\*Status\*\*:\s+\*\*deprecated\*\*/i.test(section)) continue;
    const word = headerMatch[1];
    if (word && !BUILT_IN_RULES.some(r => r.word === word)) {
      terms.push({
        pattern: new RegExp(`\\b${word}[ds]?\\b`, "gi"),
        word,
        replacement: "restart (see GLOSSARY.md)",
        section: "dynamic",
      });
    }
  }
  return terms;
}

function isQuoted(lineText: string, matchIndex: number, matchWord: string): boolean {
  const before = lineText.slice(0, matchIndex);
  const after = lineText.slice(matchIndex + matchWord.length);
  if (before.endsWith('"') && after.startsWith('"')) return true;
  if (before.endsWith("'") && after.startsWith("'")) return true;
  if (before.endsWith('`') && after.startsWith('`')) return true;
  if (before.endsWith('~~') && after.startsWith('~~')) return true;
  if (before.endsWith('*') && after.startsWith('*')) return true;
  return false;
}

function isCorrectionLine(lineText: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\|\s+correction\s+\|/i.test(lineText)
    || lineText.includes("→ actual:")
    || lineText.includes("CORRECTION");
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  const stat = statSync(dir);
  if (stat.isFile()) return [dir];

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (!SKIP_EXTENSIONS.has(ext.toLowerCase())) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function findMatches(line: string, pattern: RegExp): Array<{ index: number; match: string }> {
  const results: Array<{ index: number; match: string }> = [];
  for (const m of line.matchAll(pattern)) {
    if (m.index !== undefined) {
      results.push({ index: m.index, match: m[0] });
    }
  }
  return results;
}

export async function cmdLexiconVerify(opts: VerifyOpts): Promise<VerifyResult> {
  const cwd = process.cwd();
  const glossaryPath = opts.glossaryPath ?? join(cwd, "ψ", "GLOSSARY.md");

  const rules = [...BUILT_IN_RULES];
  if (existsSync(glossaryPath)) {
    const glossaryContent = readFileSync(glossaryPath, "utf-8");
    rules.push(...parseGlossary(glossaryContent));
    console.log(`Loaded GLOSSARY from ${relative(cwd, glossaryPath)} (${rules.length} rules)`);
  } else {
    console.log(`No GLOSSARY at ${glossaryPath} — using ${rules.length} built-in rules`);
  }

  const paths = opts.paths ?? DEFAULT_PATHS.map(p => join(cwd, p));
  const allFiles: string[] = [];
  for (const p of paths) {
    const resolved = p.startsWith("/") ? p : join(cwd, p);
    allFiles.push(...collectFiles(resolved));
  }

  if (allFiles.length === 0) {
    console.log("No files found to scan.");
    return { violations: 0, files: 0, clean: 0 };
  }

  const violations: Violation[] = [];

  for (const file of allFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCorrectionLine(line)) continue;

      for (const rule of rules) {
        const matches = findMatches(line, rule.pattern);
        for (const { index, match } of matches) {
          if (isQuoted(line, index, match)) continue;
          violations.push({
            file: relative(cwd, file),
            line: i + 1,
            column: index + 1,
            text: line.trim(),
            word: match,
            replacement: rule.replacement,
          });
        }
      }
    }
  }

  const cleanCount = allFiles.length - new Set(violations.map(v => v.file)).size;

  if (opts.json) {
    console.log(JSON.stringify({ violations, files: allFiles.length, clean: cleanCount }, null, 2));
  } else {
    const RED = "\x1b[31m";
    const GREEN = "\x1b[32m";
    const DIM = "\x1b[90m";
    const YELLOW = "\x1b[33m";
    const RESET = "\x1b[0m";

    console.log(`\nScanned ${allFiles.length} files\n`);

    if (violations.length === 0) {
      console.log(`${GREEN}✓ No lexicon violations found${RESET}\n`);
    } else {
      const byFile = new Map<string, Violation[]>();
      for (const v of violations) {
        const list = byFile.get(v.file) ?? [];
        list.push(v);
        byFile.set(v.file, list);
      }

      for (const [file, fileViolations] of byFile) {
        console.log(`${RED}✗${RESET} ${file} ${DIM}(${fileViolations.length} violation${fileViolations.length > 1 ? "s" : ""})${RESET}`);
        for (const v of fileViolations) {
          console.log(`  ${DIM}L${v.line}:${v.column}${RESET}  "${YELLOW}${v.word}${RESET}" → ${GREEN}${v.replacement}${RESET}`);
          console.log(`  ${DIM}${v.text.slice(0, 120)}${RESET}`);
        }
        console.log();
      }

      console.log(`${RED}${violations.length} violation${violations.length > 1 ? "s" : ""}${RESET} in ${byFile.size} file${byFile.size > 1 ? "s" : ""} · ${GREEN}${cleanCount} clean${RESET}\n`);
    }
  }

  return { violations: violations.length, files: allFiles.length, clean: cleanCount };
}
