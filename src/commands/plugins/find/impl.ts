import { hostExec } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import { loadFleet } from "../../shared/fleet-load";
import { join } from "path";
import { existsSync } from "fs";

// POSIX-correct single-quote escape: inside '…' the only metacharacter is
// the quote itself, and the shell has no escape for it — you must close,
// emit a literal quote, reopen. The prior `.replace(/'/g, "\\'")` left
// backslashes un-escaped, which CodeQL flagged as js/incomplete-sanitization
// (input `\\'` would break out of the quoting).
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * maw find <keyword> [--oracle <name>]
 *
 * Cross-oracle knowledge search.
 * Searches ψ/memory/ across all oracle repos for learnings, retros, traces.
 */
export async function cmdFind(keyword: string, opts: { oracle?: string } = {}) {
  const reposRoot = join(getGhqRoot(), "github.com");
  const fleet = loadFleet();

  console.log(`\n  \x1b[36m🔍 Searching\x1b[0m — "${keyword}"\n`);

  const results: { oracle: string; file: string; line: string }[] = [];

  // Collect oracle repo paths
  const targets: { name: string; psiPath: string }[] = [];

  for (const sess of fleet) {
    const oracleName = sess.name.replace(/^\d+-/, "");
    if (opts.oracle && oracleName !== opts.oracle) continue;

    const mainWindow = sess.windows[0];
    if (!mainWindow?.repo) continue;

    const repoPath = join(reposRoot, mainWindow.repo);
    const psiPath = join(repoPath, "ψ", "memory");
    if (existsSync(psiPath)) {
      targets.push({ name: oracleName, psiPath });
    }
  }

  // Also search current directory if it has ψ/
  const localPsi = join(process.cwd(), "ψ", "memory");
  if (existsSync(localPsi) && !targets.some(t => t.psiPath === localPsi)) {
    const cwdName = process.cwd().split("/").pop()?.replace(/-oracle$/, "") || "local";
    targets.push({ name: cwdName, psiPath: localPsi });
  }

  if (targets.length === 0) {
    console.log("  \x1b[33m⚠\x1b[0m no oracle ψ/memory/ directories found");
    return;
  }

  // Search each oracle
  for (const { name, psiPath } of targets) {
    try {
      const out = await hostExec(`grep -ril ${shSingleQuote(keyword)} ${shSingleQuote(psiPath)} 2>/dev/null || true`);
      const files = out.trim().split("\n").filter(Boolean);

      for (const file of files) {
        // Get matching line for context
        try {
          const match = await hostExec(`grep -m1 -i ${shSingleQuote(keyword)} ${shSingleQuote(file)} 2>/dev/null || true`);
          results.push({
            oracle: name,
            file: file.replace(psiPath + "/", ""),
            line: match.trim().slice(0, 120),
          });
        } catch { /* skip */ }
      }
    } catch { /* oracle may not be accessible */ }
  }

  if (results.length === 0) {
    console.log(`  \x1b[90m○\x1b[0m no matches found across ${targets.length} oracle(s)`);
    console.log();
    return;
  }

  // Group by oracle
  const grouped = new Map<string, typeof results>();
  for (const r of results) {
    if (!grouped.has(r.oracle)) grouped.set(r.oracle, []);
    grouped.get(r.oracle)!.push(r);
  }

  for (const [oracle, matches] of grouped) {
    console.log(`  \x1b[36m${oracle}\x1b[0m (${matches.length} match${matches.length > 1 ? "es" : ""})`);
    for (const m of matches.slice(0, 10)) {
      console.log(`    \x1b[90m${m.file}\x1b[0m`);
      if (m.line) console.log(`      ${m.line}`);
    }
    if (matches.length > 10) {
      console.log(`    \x1b[90m... and ${matches.length - 10} more\x1b[0m`);
    }
    console.log();
  }

  console.log(`  \x1b[32m${results.length} match(es)\x1b[0m across ${grouped.size} oracle(s) (searched ${targets.length})`);
  console.log();
}
