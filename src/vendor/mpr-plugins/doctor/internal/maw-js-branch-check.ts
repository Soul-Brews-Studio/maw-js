import { existsSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

/**
 * #1180 — Warn when local maw-js clone is on a branch behind `alpha`.
 *
 * Multiple times today, `maw bud`/`maw incubate` failed mysteriously because
 * the local maw-js was on a feature branch that lacked recent alpha fixes
 * (e.g. #1177's missing `should-auto-wake` export). Detection takes ~50 ms,
 * surfaces the issue immediately instead of after a failed bud crashes.
 *
 * Resolution order for the maw-js source path:
 *   1. $MAW_JS_SOURCE env var (explicit override)
 *   2. `ghq list` for Soul-Brews-Studio/maw-js (if ghq present)
 *   3. ~/Code/github.com/Soul-Brews-Studio/maw-js (conventional default)
 *
 * If no clone is found → ok:true with skipped message (the check is N/A
 * for users not doing maw-js development).
 *
 * Behavior:
 *   - on `alpha`        → ok, "on alpha"
 *   - no alpha ref      → ok, "no alpha branch (single-branch checkout?)"
 *   - on other branch with alpha 0 commits ahead → ok, "branch X is at parity with alpha"
 *   - on other branch with alpha N commits ahead → WARN, "branch X is N commits behind alpha"
 *     (returns ok:false so doctor exits non-zero unless --allow-drift)
 */
export async function checkMawJsBranch(): Promise<{
  name: string;
  ok: boolean;
  message: string;
}> {
  const path = resolveMawJsPath();
  if (!path) {
    return {
      name: "maw-js:branch",
      ok: true,
      message: "no local maw-js clone found (set $MAW_JS_SOURCE or clone to ~/Code/github.com/Soul-Brews-Studio/maw-js)",
    };
  }

  // Detect current branch (HEAD ref name).
  const branch = gitBranch(path);
  if (!branch) {
    return {
      name: "maw-js:branch",
      ok: true,
      message: `maw-js found at ${path} but git HEAD unreadable — skipping`,
    };
  }

  if (branch === "alpha") {
    return {
      name: "maw-js:branch",
      ok: true,
      message: `on alpha @ ${path}`,
    };
  }

  // Check whether `alpha` ref exists locally
  if (!gitRefExists(path, "alpha")) {
    return {
      name: "maw-js:branch",
      ok: true,
      message: `on '${branch}' — no local alpha ref to compare against`,
    };
  }

  // Count commits in <branch>..alpha (alpha-ahead-of-branch)
  const ahead = gitRevListCount(path, `${branch}..alpha`);
  if (ahead == null) {
    return {
      name: "maw-js:branch",
      ok: true,
      message: `on '${branch}' — could not compare with alpha`,
    };
  }

  if (ahead === 0) {
    return {
      name: "maw-js:branch",
      ok: true,
      message: `on '${branch}' — at parity with alpha`,
    };
  }

  // Drift detected
  return {
    name: "maw-js:branch",
    ok: false,
    message: `on '${branch}' — alpha has ${ahead} unmerged commit${ahead === 1 ? "" : "s"} (cd ${path} && git checkout alpha to align)`,
  };
}

function resolveMawJsPath(): string | null {
  // Explicit override: if set, trust it (return null if invalid — don't fall back).
  const env = process.env.MAW_JS_SOURCE;
  if (env !== undefined && env !== "") {
    return existsGitRepo(env) ? env : null;
  }

  // ghq list
  try {
    const raw = execSync("ghq list 2>/dev/null", { encoding: "utf-8" });
    const root = (() => {
      try {
        return execSync("ghq root 2>/dev/null", { encoding: "utf-8" }).trim();
      } catch {
        return null;
      }
    })();
    if (root) {
      const match = raw
        .split("\n")
        .find(l => l.endsWith("/Soul-Brews-Studio/maw-js"));
      if (match) {
        const full = join(root, match);
        if (existsGitRepo(full)) return full;
      }
    }
  } catch {
    /* ghq not available */
  }

  // Conventional default
  const conventional = join(homedir(), "Code", "github.com", "Soul-Brews-Studio", "maw-js");
  if (existsGitRepo(conventional)) return conventional;

  return null;
}

function existsGitRepo(path: string): boolean {
  try {
    return existsSync(join(path, ".git"));
  } catch {
    return false;
  }
}

function gitBranch(path: string): string | null {
  try {
    const out = execSync(`git -C '${path.replace(/'/g, "'\\''")}' branch --show-current 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function gitRefExists(path: string, ref: string): boolean {
  try {
    execSync(
      `git -C '${path.replace(/'/g, "'\\''")}' rev-parse --verify '${ref}' 2>/dev/null`,
      { encoding: "utf-8" },
    );
    return true;
  } catch {
    return false;
  }
}

function gitRevListCount(path: string, range: string): number | null {
  try {
    const out = execSync(
      `git -C '${path.replace(/'/g, "'\\''")}' rev-list --count '${range}' 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
