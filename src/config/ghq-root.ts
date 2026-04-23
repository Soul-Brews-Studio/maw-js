/**
 * On-demand resolver for the BARE ghq root.
 *
 * Returns the bare filesystem path that `ghq root` prints — *without* the
 * `github.com/` host suffix. Callers that need the host-nested repos root
 * must append `"github.com"` themselves, e.g.
 *
 *   join(getGhqRoot(), "github.com", org, repo)
 *
 * Resolution order:
 *   1. `loadConfig().ghqRoot` — legacy override (bare shape, warn-once).
 *   2. `GHQ_ROOT` env var.
 *   3. `ghq root` CLI output.
 *   4. Fallback: `~/Code` (pre-`ghq init` hosts).
 *
 * The result is cached per process. Use `resetGhqRootCache()` from tests.
 *
 * Historical drift:
 *   - Before this refactor (#680), `config.ghqRoot` was load-bearing and could
 *     be either bare or nested (github.com-rooted). Most callers assumed the
 *     nested shape and wrote `join(ghqRoot, org, repo)` — which silently
 *     resolved to the wrong path when the value was actually bare. Centralizing
 *     the resolver here and mandating the bare shape fixes that class of bug.
 */

import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

let _cached: string | null = null;
let _warnedLegacy = false;

/** Normalize a raw ghqRoot value to the BARE shape (strip trailing /github.com). */
function normalizeBare(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/github\.com$/, "");
}

/** Reset the process-level cache. Test-only. */
export function resetGhqRootCache(): void {
  _cached = null;
  _warnedLegacy = false;
}

/**
 * Resolve the BARE ghq root on demand.
 *
 * Never throws — on total failure returns `~/Code`.
 */
export function getGhqRoot(): string {
  if (_cached) return _cached;

  // (1) legacy override from config — take precedence so existing test mocks
  //     and the explicit override path keep working.
  try {
    // Lazy require so this module has no hard dep on loadConfig at import time
    // (avoids a cycle with config/load.ts).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadConfig } = require("./load") as typeof import("./load");
    const cfg = loadConfig() as { ghqRoot?: string };
    if (typeof cfg.ghqRoot === "string" && cfg.ghqRoot.length > 0) {
      const bare = normalizeBare(cfg.ghqRoot);
      if (!_warnedLegacy) {
        _warnedLegacy = true;
        // Soft warning — use stderr so it doesn't pollute JSON output on stdout.
        process.stderr.write(
          `[maw] config.ghqRoot is deprecated — ghq root is now resolved on demand. ` +
          `Remove "ghqRoot" from your maw.config.json (using "${bare}" for this run).\n`,
        );
      }
      _cached = bare;
      return _cached;
    }
  } catch { /* loadConfig may fail during early bootstrap — fall through */ }

  // (2) env var
  const envRoot = process.env.GHQ_ROOT;
  if (envRoot && envRoot.length > 0) {
    _cached = normalizeBare(envRoot);
    return _cached;
  }

  // (3) shell out to ghq
  try {
    const out = execSync("ghq root", { encoding: "utf-8" }).trim();
    if (out.length > 0) {
      _cached = normalizeBare(out);
      return _cached;
    }
  } catch { /* ghq missing — fall through */ }

  // (4) fallback
  _cached = join(homedir(), "Code");
  return _cached;
}
