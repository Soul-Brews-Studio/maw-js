/**
 * maw token scan — port of token-oracle/cmd/scan.py.
 *
 * Audit every ghq-managed repo's .envrc for which Claude token is
 * active, grouping by token name. Two-stage match:
 *
 *   1. Structured detection via detectActiveToken() — token NAME only.
 *   2. Fallback: fingerprint match — checks if the literal token value
 *      from pass appears in the .envrc text. Token values are held in
 *      memory inside `fingerprintTokens()` and tested with substring
 *      membership only — never printed, never logged.
 *
 * Unlike the Python original, this port has **no ~/Code/github.com
 * fallback**: ghq is the single source of truth. If `ghq root` is
 * unset or empty, scan reports the gap loudly instead of silently
 * searching a hardcoded path. (Per issue #54 implementation notes.)
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { detectActiveToken, fingerprintTokens, run } from "./lib";

export type ScanMethod = "named" | "matched" | "unmatched";

export interface ScanRow {
  label: string;
  tokenName: string;
  method: ScanMethod;
}

export interface ScanResult {
  ok: boolean;
  rows: ScanRow[];
  ghqRoot: string | null;
  error?: string;
}

/**
 * Resolve ghq root (e.g. `~/ghq/github.com`). Returns null if ghq is
 * unavailable or the resolved path is not a real directory. Caller
 * decides how to surface that to the user — we refuse to fall back to
 * a hardcoded path.
 */
export function resolveGhqRoot(): string | null {
  const r = run(["ghq", "root"]);
  if (!r.ok) return null;
  const root = r.stdout.trim();
  if (!root) return null;
  const githubRoot = join(root, "github.com");
  try {
    if (statSync(githubRoot).isDirectory()) return githubRoot;
  } catch {
    /* fall through */
  }
  return null;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Collect (label, path) tuples for every .envrc to be inspected:
 *   - <home>/.envrc (label "~")
 *   - <ghqRoot>/<org>/<repo>/.envrc (label "org/repo")
 *
 * `home` defaults to `homedir()`; tests pass a tmp dir to keep the
 * walk hermetic (the real ~/.envrc would otherwise show up as an
 * extra row).
 */
export function findEnvrcFiles(
  ghqRoot: string,
  home: string = homedir(),
): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = [];

  const homeEnvrc = join(home, ".envrc");
  if (isFile(homeEnvrc)) out.push({ label: "~", path: homeEnvrc });

  for (const org of safeReadDir(ghqRoot).sort()) {
    const orgPath = join(ghqRoot, org);
    if (!isDir(orgPath)) continue;
    for (const repo of safeReadDir(orgPath).sort()) {
      const repoPath = join(orgPath, repo);
      if (!isDir(repoPath)) continue;
      const envrc = join(repoPath, ".envrc");
      if (isFile(envrc)) out.push({ label: `${org}/${repo}`, path: envrc });
    }
  }

  return out;
}

export interface ScanOptions {
  /** Override for `~` — tests use a tmp dir so the real ~/.envrc doesn't bleed in. */
  home?: string;
}

export function cmdScan(opts: ScanOptions = {}): ScanResult {
  const ghqRoot = resolveGhqRoot();
  if (!ghqRoot) {
    return {
      ok: false,
      rows: [],
      ghqRoot: null,
      error:
        "ghq root unavailable — install ghq or set up ~/ghq/github.com (no hardcoded fallback)",
    };
  }

  // Held in memory only — keys are full token values. NEVER iterate
  // this Map for any printing path.
  const fingerprints = fingerprintTokens();

  const files = findEnvrcFiles(ghqRoot, opts.home);
  const rows: ScanRow[] = [];

  for (const { label, path } of files) {
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    const detected = detectActiveToken(content);
    if (detected) {
      rows.push({ label, tokenName: detected, method: "named" });
      continue;
    }

    // Fallback: substring-match a known token value inside the file.
    // tokenVal is only used as the haystack-needle here; it is not
    // returned, logged, or stored anywhere outside this loop.
    let matched: string | null = null;
    for (const [tokenVal, tokenName] of fingerprints.entries()) {
      if (content.includes(tokenVal)) {
        matched = tokenName;
        break;
      }
    }
    if (matched) {
      rows.push({ label, tokenName: matched, method: "matched" });
    } else if (content.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
      rows.push({ label, tokenName: "unknown", method: "unmatched" });
    }
  }

  return { ok: true, rows, ghqRoot };
}

export function formatScan(r: ScanResult): string {
  if (!r.ok) return `scan: ${r.error}`;
  if (r.rows.length === 0) return "No .envrc files with Claude tokens found";

  const byToken = new Map<string, Array<{ label: string; method: ScanMethod }>>();
  for (const row of r.rows) {
    const list = byToken.get(row.tokenName) ?? [];
    list.push({ label: row.label, method: row.method });
    byToken.set(row.tokenName, list);
  }

  const out: string[] = [];
  out.push(`  ${r.rows.length} oracles using ${byToken.size} tokens:`);
  out.push("");

  const names = [...byToken.keys()].sort();
  names.forEach((tokenName, i) => {
    const repos = byToken.get(tokenName)!;
    out.push(`  ${i + 1}. ${tokenName} (${repos.length} repos)`);
    for (const { label, method } of repos) {
      const flag = method === "unmatched" ? " *" : "";
      out.push(`     ${label}${flag}`);
    }
    out.push("");
  });

  if (r.rows.some(row => row.method === "unmatched")) {
    out.push("  * = token not in pass vault (unknown)");
  }
  return out.join("\n");
}
