import { spawnSync } from "child_process";
import { openSync, readSync, closeSync } from "fs";
import { hostExec } from "../../sdk";
import { loadConfig } from "../../config";
import { tlink } from "../../core/util/terminal";

export interface OrgEntry {
  name: string;
  source: string;
}

interface ScanSuggestDeps {
  /** Synchronous exec — used for ghq list, gh repo view, gh --version */
  execFn?: (cmd: string) => string;
  /**
   * y/N prompt. Returns true=yes, false=no, null=non-TTY/unavailable.
   * Defaults to /dev/tty with graceful fallback.
   */
  promptFn?: (msg: string) => boolean | null;
  /** Async exec — used for ghq get and ghq list --full-path */
  hostExecFn?: (cmd: string) => Promise<string>;
  /** Load maw config (injectable for tests) */
  configFn?: () => any;
  /**
   * #770 — bypass owned/member-org filter and scan every locally-cloned org.
   * Rare third-party-org case (oracle spawned into someone else's org).
   */
  allLocal?: boolean;
}

/**
 * #770 — Result of probing GitHub for the orgs the authenticated user can
 * actually own a repo in. `ok: false` triggers a graceful fallback to the
 * unfiltered (all-local) scan with a warning.
 */
type AllowedOrgs =
  | { ok: true; user: string; orgs: Set<string> }
  | { ok: false; reason: string };

/**
 * Extract unique org names from `ghq list` output (github.com/<org>/<repo> format).
 * @internal — exported for tests only.
 */
export function extractGhqOrgs(ghqOutput: string): string[] {
  const orgs = new Set<string>();
  for (const line of ghqOutput.split("\n")) {
    const parts = line.trim().split("/");
    // e.g. "github.com/Soul-Brews-Studio/wireboy-oracle" → parts[1] = org
    if (parts.length >= 3 && parts[1]) orgs.add(parts[1]);
  }
  return [...orgs].sort();
}

/**
 * Process-lifetime cache for the user's owned + member orgs. Single `gh api
 * user/orgs` per maw invocation; reset between tests via `_resetAllowedOrgsCache`.
 */
let _allowedOrgsCache: AllowedOrgs | null = null;

/** @internal — exported only so tests can isolate cases. */
export function _resetAllowedOrgsCache(): void { _allowedOrgsCache = null; }

/**
 * Probe `gh api user` and `gh api user/orgs` to derive the orgs the user can
 * actually host a repo in. Cached on first call. On any failure (no auth,
 * offline, gh missing) returns `ok: false` so the caller can fall back to the
 * legacy all-local scan with a warning rather than silently empty out.
 *
 * @internal — exported for tests only.
 */
export function fetchAllowedOrgs(execFn: (cmd: string) => string): AllowedOrgs {
  if (_allowedOrgsCache) return _allowedOrgsCache;

  let user: string;
  try {
    user = execFn("gh api user --jq .login 2>/dev/null").trim();
    if (!user) throw new Error("empty login");
  } catch (e: any) {
    const reason = `gh api user failed: ${String(e?.message || e).split("\n")[0]}`;
    return (_allowedOrgsCache = { ok: false, reason });
  }

  const orgs = new Set<string>([user]);
  try {
    const raw = execFn("gh api user/orgs --jq '.[].login' 2>/dev/null");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t) orgs.add(t);
    }
  } catch {
    // user lookup worked but org listing failed (e.g. token without `read:org`).
    // Falling through with just the user is still better than scanning all-local.
  }

  return (_allowedOrgsCache = { ok: true, user, orgs });
}

/**
 * Keep only orgs that match `allowed.orgs` (case-sensitive — GitHub org slugs).
 * @internal — exported for tests only.
 */
export function filterOrgsByAllowed(orgs: OrgEntry[], allowed: AllowedOrgs): OrgEntry[] {
  if (!allowed.ok) return orgs;
  return orgs.filter(o => allowed.orgs.has(o.name));
}

/**
 * Combine orgs from ghq list + config, deduped, sorted case-insensitively.
 * @internal — exported for tests only.
 */
export function buildOrgList(ghqOutput: string, cfg: any): OrgEntry[] {
  const ghqOrgs = extractGhqOrgs(ghqOutput);
  const result: OrgEntry[] = ghqOrgs.map(name => ({ name, source: "local" }));
  const cfgOrgs: string[] = cfg.githubOrgs || (cfg.githubOrg ? [cfg.githubOrg] : []);
  for (const org of cfgOrgs) {
    if (!result.find(e => e.name === org)) {
      result.push({ name: org, source: "config" });
    }
  }
  return result.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Default synchronous exec — throws on non-zero exit. */
function defaultExecFn(cmd: string): string {
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr || `command failed: ${cmd}`);
  return r.stdout || "";
}

/**
 * Read a single chunk from /dev/tty. Returns {ok,text,n}. ok=false on error/unavailable.
 * Exposed for testing the leftover-newline retry loop in readTtyAnswer.
 */
export type TtyReader = () => { ok: true; text: string; n: number } | { ok: false };

function defaultTtyReader(): ReturnType<TtyReader> {
  try {
    const buf = Buffer.alloc(8);
    const fd = openSync("/dev/tty", "r");
    const n = readSync(fd, buf, 0, buf.length, null);
    closeSync(fd);
    return { ok: true, text: buf.slice(0, n).toString(), n };
  } catch {
    return { ok: false };
  }
}

/**
 * Read y/N answer from TTY, tolerating a leftover `\n` left behind by a prior
 * prompt (e.g. inquirer). If the first read yields whitespace-only with n>0,
 * loop and read again — up to 3 attempts. Returns null if TTY unavailable or
 * all attempts were empty.
 *
 * @internal — exported for tests only.
 */
export function readTtyAnswer(reader: TtyReader = defaultTtyReader): string | null {
  for (let i = 0; i < 3; i++) {
    const r = reader();
    if (!r.ok) return null;
    if (r.n === 0) return null; // EOF
    const trimmed = r.text.trim();
    if (trimmed.length > 0) return trimmed.toLowerCase();
    // whitespace-only (e.g. leftover '\n') — retry
  }
  return null;
}

/** TTY y/N prompt. Returns true/false/null (null = /dev/tty unavailable or empty). */
function defaultPromptFn(msg: string): boolean | null {
  try {
    process.stdout.write(msg);
    const answer = readTtyAnswer();
    if (answer === null) return null;
    if (answer === "y" || answer === "yes") return true;
    return false;
  } catch {
    return null;
  }
}

/** Check if a repo exists on GitHub. Returns its URL or null. */
function checkGhRepo(slug: string, execFn: (cmd: string) => string): string | null {
  try {
    const out = execFn(`gh repo view '${slug}' --json url 2>/dev/null`);
    const parsed = JSON.parse(out || "{}");
    return parsed.url || null;
  } catch {
    return null;
  }
}

/**
 * Scan orgs for <oracle>-oracle, stop on first match. Returns URL or null.
 * @internal — exported for tests only.
 */
export function scanOrgs(
  oracle: string,
  orgs: OrgEntry[],
  execFn: (cmd: string) => string,
): { org: string; url: string } | null {
  const stem = oracle.endsWith("-oracle") ? oracle : `${oracle}-oracle`;
  for (const { name: org } of orgs) {
    process.stdout.write(`→ scanning ${org}/${stem} ... `);
    const url = checkGhRepo(`${org}/${stem}`, execFn);
    if (url) {
      console.log(`FOUND  ${tlink(url)}`);
      return { org, url };
    }
    console.log("not found");
  }
  return null;
}

/**
 * Offer to scan known orgs for <oracle>-oracle when all local resolution fails.
 *
 * Returns resolved repo info if found and cloned, or null if skipped/not found.
 * Calls process.exit(0) if user explicitly aborts (says N).
 */
export async function scanSuggestOracle(
  oracle: string,
  deps?: ScanSuggestDeps,
): Promise<{ repoPath: string; repoName: string; parentDir: string } | null> {
  const cfg = deps?.configFn ? deps.configFn() : loadConfig();
  const execFn = deps?.execFn ?? defaultExecFn;
  const promptFn = deps?.promptFn ?? defaultPromptFn;
  const hostExecFn = deps?.hostExecFn ?? hostExec;

  // Check gh is available
  try { execFn("gh --version 2>/dev/null"); }
  catch {
    console.error(`\x1b[90mgh cli required for scan suggestion; install via brew/apt\x1b[0m`);
    return null;
  }

  // Collect orgs: ghq list gives local ones, config gives configured ones
  let ghqOutput = "";
  try { ghqOutput = execFn("ghq list"); } catch { /* no ghq or empty */ }

  const allOrgs = buildOrgList(ghqOutput, cfg);

  if (allOrgs.length === 0) {
    console.error(`\x1b[90mno orgs configured; set githubOrg in config or: ghq get <url>  then re-run\x1b[0m`);
    return null;
  }

  // #770 — filter to owned/member orgs unless --all-local was passed.
  // Read-only clones of upstream code (anthropics, NousResearch, etc.) can never
  // host the user's oracle, so probing them wastes API budget and clutters the prompt.
  let orgs = allOrgs;
  let scopeNote = "scope: --all-local (no filter)";
  if (!deps?.allLocal) {
    const allowed = fetchAllowedOrgs(execFn);
    if (allowed.ok) {
      orgs = filterOrgsByAllowed(allOrgs, allowed);
      scopeNote = "scope: owned + member orgs only";
      if (orgs.length === 0) {
        console.error(`\x1b[33m⚠\x1b[0m no locally-cloned orgs are owned by or shared with @${allowed.user}; pass --all-local to override`);
        return null;
      }
    } else {
      console.error(`\x1b[33m⚠\x1b[0m org-scope filter unavailable (${allowed.reason}); falling back to all local`);
      scopeNote = "scope: all local (org-fetch failed)";
    }
  }

  // Strip -oracle suffix if caller passed it (we always append exactly once)
  const name = oracle.endsWith("-oracle") ? oracle.slice(0, -7) : oracle;
  const stem = `${name}-oracle`;

  // Display scan plan — flat, 1-2 indent levels max
  const orgLines = orgs.map(o => {
    const ghUrl = `https://github.com/${o.name}/${stem}`;
    return `  ${tlink(ghUrl, o.name.padEnd(24))} (${o.source})`;
  }).join("\n");
  console.log(`\n\x1b[36m🔍 Scan for ${stem}?\x1b[0m\n`);
  console.log(`Provider: github.com (${scopeNote})`);
  console.log(`Orgs (${orgs.length}, sorted):\n${orgLines}\n`);
  console.log(`Will check: gh repo view <org>/${stem}  (${orgs.length} request${orgs.length !== 1 ? "s" : ""})\n`);

  // Prompt
  const response = promptFn("Scan now? [y/N] ");
  if (response === null) {
    // Non-TTY — can't prompt, print manual hint and bail
    console.log(`\x1b[90m(non-interactive — cannot prompt)\x1b[0m`);
    console.log(`\x1b[90mManually: gh repo view <org>/${stem}  then: ghq get -u <url>  then re-run maw wake ${name}\x1b[0m`);
    return null;
  }
  if (!response) {
    console.log(`\x1b[90maborted. Manually: ghq get -u <url>  then re-run maw wake ${name}\x1b[0m`);
    process.exit(0);
  }

  // Scan loop — stop on first match
  const found = scanOrgs(name, orgs, execFn);
  if (!found) {
    console.error(`\x1b[33mno org had ${stem}\x1b[0m`);
    console.error(`\x1b[90mTry: maw bud ${name}  OR  ghq get <url>  manually\x1b[0m`);
    return null;
  }

  // Clone
  const cloneUrl = found.url;
  console.log(`\n\x1b[36m⚡ ghq get -u ${tlink(cloneUrl)}\x1b[0m`);
  try {
    await hostExecFn(`ghq get -u '${cloneUrl}'`);
  } catch (e: any) {
    console.error(`\x1b[33m⚠\x1b[0m clone failed: ${String(e?.message || e).split("\n")[0]}`);
    return null;
  }

  const cloned = await hostExecFn(`ghq list --full-path | grep -i '/${stem}$' | head -1`);
  if (!cloned?.trim()) {
    console.error(`\x1b[33m⚠\x1b[0m clone succeeded but path not found in ghq list`);
    return null;
  }

  const repoPath = cloned.trim();
  console.log(`\x1b[32m✓ cloned to ${repoPath}\x1b[0m`);
  console.log(`\ncontinuing wake...`);
  return { repoPath, repoName: repoPath.split("/").pop()!, parentDir: repoPath.replace(/\/[^/]+$/, "") };
}
