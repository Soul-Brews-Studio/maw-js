import { scanAndCache, scanFull, scanRemote, readCache } from "../../../sdk";
import { cmdOracleList, type OracleListOpts } from "./impl-list";
import { isQuiet } from "../../../cli/verbosity";

export async function cmdOracleScan(opts: { force?: boolean; json?: boolean; local?: boolean; remote?: boolean; all?: boolean; verbose?: boolean; quiet?: boolean } = {}) {
  const start = Date.now();

  // Default to local (fast). Use --all or --remote for GitHub API scan.
  const mode = opts.all ? "both" : opts.remote ? "remote" : "local";

  // Verbose by default (alpha.74, feedback_verbose_by_default). --quiet /
  // MAW_QUIET=1 opts out to the terse summary; --verbose forces loud even
  // under MAW_QUIET.
  const loud = opts.verbose === true ? true : !(opts.quiet || isQuiet());

  if (mode === "remote") {
    // Remote only — GitHub API. Loud on failure.
    console.log(`\n  \x1b[36m📡\x1b[0m Scanning GitHub orgs for *-oracle repos...\n`);
    const entries = await scanRemote(undefined, loud);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    console.log(`  \x1b[32m✓\x1b[0m Found ${entries.length} oracles remotely (${elapsed}s)\n`);
    for (const e of entries) {
      const psi = e.has_psi ? "\x1b[32mψ/\x1b[0m" : "\x1b[90m  \x1b[0m";
      console.log(`    ${psi} ${e.org}/${e.name}`);
    }
    console.log();
    return;
  }

  if (mode === "local") {
    // Local scan. Verbose-by-default: show per-org + per-oracle detection.
    // `--quiet` suppresses the detail and returns to the terse summary line.
    const prev = readCache();
    const prevKeys = new Set((prev?.oracles || []).map(o => `${o.org}/${o.repo}`));

    if (loud) console.log();  // blank line before verbose output

    const cache = scanAndCache("local", loud);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }

    const currKeys = new Set(cache.oracles.map(o => `${o.org}/${o.repo}`));
    const addedKeys = [...currKeys].filter(k => !prevKeys.has(k));
    const removedKeys = [...prevKeys].filter(k => !currKeys.has(k));

    let delta: string;
    if (!prev) {
      delta = `${cache.oracles.length} new`;
    } else if (addedKeys.length === 0 && removedKeys.length === 0) {
      delta = "no change";
    } else {
      delta = `+${addedKeys.length} -${removedKeys.length} since last`;
    }

    // Enumerate delta + cache file location when loud.
    if (loud) {
      if (addedKeys.length > 0) {
        console.log(`  \x1b[32m+\x1b[0m added: ${addedKeys.join(", ")}`);
      }
      if (removedKeys.length > 0) {
        console.log(`  \x1b[31m-\x1b[0m removed: ${removedKeys.join(", ")}`);
      }
      const { CACHE_FILE } = await import("../../../core/fleet/registry-oracle-types");
      console.log(`  \x1b[90m  cache: ${CACHE_FILE}\x1b[0m`);
    }

    console.log(`\n  \x1b[32m✓\x1b[0m ${cache.oracles.length} oracles locally (${delta}) in ${elapsed}s\n`);
    return;
  }

  // Both — full picture
  console.log(`\n  \x1b[36m📡\x1b[0m Full scan: local + GitHub remote...\n`);
  const cache = await scanFull(undefined, loud);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }

  const localCount = cache.oracles.filter(o => o.local_path).length;
  const remoteOnly = cache.oracles.filter(o => !o.local_path).length;
  console.log(`  \x1b[32m✓\x1b[0m ${cache.oracles.length} oracles (${localCount} local, ${remoteOnly} remote-only) (${elapsed}s)\n`);
  const { CACHE_FILE } = await import("../../../core/fleet/registry-oracle-types");
  console.log(`  Cache written to \x1b[90m${CACHE_FILE}\x1b[0m\n`);
}

/**
 * @deprecated Use `cmdOracleList` — `maw oracle fleet` is now an alias for `maw oracle ls`.
 * Preserved so external importers don't break. Emits a stderr deprecation
 * notice and delegates to the new grouped list view.
 */
export async function cmdOracleFleet(opts: OracleListOpts = {}) {
  console.error(
    `\x1b[33m⚠  maw oracle fleet is deprecated — use \x1b[36mmaw oracle ls\x1b[0m\x1b[33m instead\x1b[0m`,
  );
  await cmdOracleList(opts);
}
