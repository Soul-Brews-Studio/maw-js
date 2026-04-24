import { hostExec } from "../../../sdk";
import { getGhqRoot } from "../../../config/ghq-root";
import { loadFleet } from "../../shared/fleet-load";
import { join } from "path";
import { existsSync, readdirSync } from "fs";

// POSIX-correct single-quote escape: inside '…' the only metacharacter is
// the quote itself, and the shell has no escape for it — you must close,
// emit a literal quote, reopen. The prior `.replace(/'/g, "\\'")` left
// backslashes un-escaped, which CodeQL flagged as js/incomplete-sanitization
// (input `\\'` would break out of the quoting).
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Section types ──────────────────────────────────────────────

interface OracleMatch {
  name: string;
  repo: string;
}

interface FleetMatch {
  session: string;
  detail: string;
}

interface CodeMatch {
  oracle: string;
  file: string;
  line: string;
}

// ── Render helpers ─────────────────────────────────────────────

function sectionHeader(title: string): void {
  console.log(`  \x1b[36m── ${title} ──\x1b[0m`);
}

/**
 * maw find <keyword> [--oracle <name>]
 *
 * Cross-oracle knowledge search.
 * Results ranked: Oracle matches → Fleet data → Code (ψ/memory grep).
 * Empty sections are skipped silently.
 */
export async function cmdFind(keyword: string, opts: { oracle?: string } = {}) {
  const reposRoot = join(getGhqRoot(), "github.com");
  const fleet = loadFleet();
  const kw = keyword.toLowerCase();

  console.log(`\n  \x1b[36m🔍 Searching\x1b[0m — "${keyword}"\n`);

  // ────────────────────────────────────────────────────────────
  // 1. Oracle matches — name or repo slug contains the keyword
  // ────────────────────────────────────────────────────────────
  const oracleMatches: OracleMatch[] = [];

  // Scan all orgs under ghqRoot/github.com for repos matching keyword
  try {
    const orgs = readdirSync(join(reposRoot), { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const org of orgs) {
      const orgPath = join(reposRoot, org.name);
      try {
        const repos = readdirSync(orgPath, { withFileTypes: true })
          .filter(d => d.isDirectory());
        for (const repo of repos) {
          const slug = `${org.name}/${repo.name}`;
          const repoName = repo.name.replace(/-oracle$/, "");
          if (
            repoName.toLowerCase().includes(kw) ||
            slug.toLowerCase().includes(kw)
          ) {
            // If --oracle flag, only include matching oracle name
            if (opts.oracle && repoName !== opts.oracle) continue;
            oracleMatches.push({ name: repoName, repo: slug });
          }
        }
      } catch { /* org dir not readable */ }
    }
  } catch { /* reposRoot not readable */ }

  // ────────────────────────────────────────────────────────────
  // 2. Fleet matches — session names, agent names, repo paths
  // ────────────────────────────────────────────────────────────
  const fleetMatches: FleetMatch[] = [];

  for (const sess of fleet) {
    const oracleName = sess.name.replace(/^\d+-/, "");
    if (opts.oracle && oracleName !== opts.oracle) continue;

    // Session name match
    if (sess.name.toLowerCase().includes(kw) || oracleName.toLowerCase().includes(kw)) {
      fleetMatches.push({
        session: sess.name,
        detail: `session ${sess.name}`,
      });
    }

    // Window/repo matches
    for (const win of sess.windows) {
      if (
        win.name.toLowerCase().includes(kw) ||
        (win.repo && win.repo.toLowerCase().includes(kw))
      ) {
        fleetMatches.push({
          session: sess.name,
          detail: `window ${win.name}${win.repo ? ` (${win.repo})` : ""}`,
        });
      }
    }

    // Sync peers match
    if (sess.sync_peers) {
      for (const peer of sess.sync_peers) {
        if (peer.toLowerCase().includes(kw)) {
          fleetMatches.push({
            session: sess.name,
            detail: `sync_peer ${peer}`,
          });
        }
      }
    }

    // Project repos match
    if (sess.project_repos) {
      for (const pr of sess.project_repos) {
        if (pr.toLowerCase().includes(kw)) {
          fleetMatches.push({
            session: sess.name,
            detail: `project_repo ${pr}`,
          });
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // 3. Code matches — grep ψ/memory across oracle repos
  // ────────────────────────────────────────────────────────────
  const codeResults: CodeMatch[] = [];

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

  // Search each oracle's ψ/memory
  for (const { name, psiPath } of targets) {
    try {
      const out = await hostExec(`grep -ril ${shSingleQuote(keyword)} ${shSingleQuote(psiPath)} 2>/dev/null || true`);
      const files = out.trim().split("\n").filter(Boolean);

      for (const file of files) {
        try {
          const match = await hostExec(`grep -m1 -i ${shSingleQuote(keyword)} ${shSingleQuote(file)} 2>/dev/null || true`);
          codeResults.push({
            oracle: name,
            file: file.replace(psiPath + "/", ""),
            line: match.trim().slice(0, 120),
          });
        } catch { /* skip */ }
      }
    } catch { /* oracle may not be accessible */ }
  }

  // ────────────────────────────────────────────────────────────
  // Render in priority order: Oracle → Fleet → Code
  // ────────────────────────────────────────────────────────────
  const totalMatches = oracleMatches.length + fleetMatches.length + codeResults.length;

  if (totalMatches === 0) {
    console.log(`  \x1b[90m○\x1b[0m no matches found across ${targets.length} oracle(s)`);
    console.log();
    return;
  }

  // Section 1: Oracles
  if (oracleMatches.length > 0) {
    sectionHeader("Oracles");
    for (const m of oracleMatches) {
      console.log(`    \x1b[1m${m.name}\x1b[0m \x1b[90m(${m.repo})\x1b[0m`);
    }
    console.log();
  }

  // Section 2: Fleet
  if (fleetMatches.length > 0) {
    sectionHeader("Fleet");
    for (const m of fleetMatches) {
      console.log(`    \x1b[90m${m.detail}\x1b[0m`);
    }
    console.log();
  }

  // Section 3: Code
  if (codeResults.length > 0) {
    sectionHeader("Code");

    // Group by oracle
    const grouped = new Map<string, CodeMatch[]>();
    for (const r of codeResults) {
      if (!grouped.has(r.oracle)) grouped.set(r.oracle, []);
      grouped.get(r.oracle)!.push(r);
    }

    for (const [oracle, matches] of grouped) {
      console.log(`    \x1b[36m${oracle}\x1b[0m (${matches.length} match${matches.length > 1 ? "es" : ""})`);
      for (const m of matches.slice(0, 10)) {
        console.log(`      \x1b[90m${m.file}\x1b[0m`);
        if (m.line) console.log(`        ${m.line}`);
      }
      if (matches.length > 10) {
        console.log(`      \x1b[90m... and ${matches.length - 10} more\x1b[0m`);
      }
    }
    console.log();
  }

  // Summary
  const parts: string[] = [];
  if (oracleMatches.length > 0) parts.push(`${oracleMatches.length} oracle(s)`);
  if (fleetMatches.length > 0) parts.push(`${fleetMatches.length} fleet`);
  if (codeResults.length > 0) parts.push(`${codeResults.length} code`);
  console.log(`  \x1b[32m${totalMatches} match(es)\x1b[0m — ${parts.join(", ")}`);
  console.log();
}
