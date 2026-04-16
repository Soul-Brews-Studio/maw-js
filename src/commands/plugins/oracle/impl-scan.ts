import { scanAndCache, scanFull, scanRemote, readCache, isCacheStale, type OracleEntry } from "../../../sdk";
import { timeSince } from "./impl-helpers";

export async function cmdOracleScan(opts: { force?: boolean; json?: boolean; local?: boolean; remote?: boolean; all?: boolean; verbose?: boolean } = {}) {
  const start = Date.now();

  // Default to local (fast). Use --all or --remote for GitHub API scan.
  const mode = opts.all ? "both" : opts.remote ? "remote" : "local";

  if (mode === "remote") {
    // Remote only — GitHub API
    console.log(`\n  \x1b[36m📡\x1b[0m Scanning GitHub orgs for *-oracle repos...\n`);
    const entries = await scanRemote(undefined, opts.verbose);
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
    // Local only — scan + list results
    const cache = scanAndCache("local");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }
    console.log(`\n  \x1b[32m✓\x1b[0m Scanned ${cache.oracles.length} oracles locally (${elapsed}s)\n`);
    for (const o of cache.oracles) {
      const org = o.org ? `\x1b[90m${o.org}/\x1b[0m` : "";
      console.log(`  ${org}\x1b[36m${o.name}\x1b[0m  \x1b[90m${o.local_path}\x1b[0m`);
    }
    console.log(`\n  Cache → \x1b[90m~/.config/maw/oracles.json\x1b[0m\n`);
    return;
  }

  // Both — full picture
  console.log(`\n  \x1b[36m📡\x1b[0m Full scan: local + GitHub remote...\n`);
  const cache = await scanFull(undefined, opts.verbose);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (opts.json) { console.log(JSON.stringify(cache, null, 2)); return; }

  const localCount = cache.oracles.filter(o => o.local_path).length;
  const remoteOnly = cache.oracles.filter(o => !o.local_path).length;
  console.log(`  \x1b[32m✓\x1b[0m ${cache.oracles.length} oracles (${localCount} local, ${remoteOnly} remote-only) (${elapsed}s)\n`);
  console.log(`  Cache written to \x1b[90m~/.config/maw/oracles.json\x1b[0m\n`);
}

export async function cmdOracleFleet(opts: { org?: string; stale?: boolean; json?: boolean; path?: boolean } = {}) {
  let cache = readCache();

  // Auto-bootstrap or refresh if stale
  if (!cache || isCacheStale(cache)) {
    if (!cache) {
      console.log(`\n  \x1b[33m📡\x1b[0m No oracle cache found. Running first local scan...\n`);
    }
    cache = scanAndCache();
  }

  if (opts.json) {
    const filtered = opts.org
      ? { ...cache, oracles: cache.oracles.filter(o => o.org === opts.org) }
      : cache;
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  // Group by org
  const byOrg = new Map<string, OracleEntry[]>();
  for (const o of cache.oracles) {
    if (opts.org && o.org !== opts.org) continue;
    const list = byOrg.get(o.org) || [];
    list.push(o);
    byOrg.set(o.org, list);
  }

  const total = [...byOrg.values()].reduce((s, l) => s + l.length, 0);
  const age = timeSince(cache.local_scanned_at);
  const fresh = !isCacheStale(cache);

  console.log(`\n  \x1b[36mOracle Fleet\x1b[0m  (${total} oracles)    local: ${age} ago ${fresh ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m"}\n`);

  for (const [org, oracles] of byOrg) {
    console.log(`  \x1b[90m${org}\x1b[0m (${oracles.length}):`);
    for (const o of oracles) {
      const icon = o.has_psi ? "\x1b[32m●\x1b[0m" : (o.has_fleet_config ? "\x1b[33m○\x1b[0m" : "\x1b[90m·\x1b[0m");
      const psiTag = o.has_psi ? "ψ/" : (o.local_path ? "  " : "\x1b[90m?\x1b[0m ");
      const lineage = o.budded_from ? `budded from ${o.budded_from}` : "root";
      const node = o.federation_node ? `· ${o.federation_node}` : "";
      const missing = !o.local_path ? " \x1b[33m(not cloned)\x1b[0m" : "";
      const pathCol = opts.path && o.local_path ? `\n        \x1b[90m${o.local_path}\x1b[0m` : "";

      console.log(`    ${icon} ${psiTag} ${o.name.padEnd(20)} ${lineage.padEnd(24)} ${node}${missing}${pathCol}`);
    }
    console.log();
  }

  if (total === 0) {
    console.log("  No oracles found. Run \x1b[90mmaw oracle scan\x1b[0m to refresh.\n");
  }
}
