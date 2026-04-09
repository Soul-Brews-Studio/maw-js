import { listSessions, hostExec, capture } from "../ssh";
import { findWorktrees, detectSession, resolveFleetSession } from "./wake";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { FLEET_DIR } from "../paths";
import { scanAndCache, readCache, isCacheStale, type OracleEntry } from "../oracle-registry";

/** Like resolveOracle but returns null instead of process.exit */
async function resolveOracleSafe(oracle: string): Promise<{ repoPath: string; repoName: string; parentDir: string } | { parentDir: ""; repoName: ""; repoPath: "" }> {
  try {
    // Try oracle-oracle pattern first
    let ghqOut = await hostExec(`ghq list --full-path | grep -i '/${oracle}-oracle$' | head -1`).catch(() => "");
    if (!ghqOut.trim()) {
      // Try direct name (e.g., homekeeper → homelab)
      ghqOut = await hostExec(`ghq list --full-path | grep -i '/${oracle}$' | head -1`).catch(() => "");
    }
    if (!ghqOut.trim()) return { parentDir: "", repoName: "", repoPath: "" };
    const repoPath = ghqOut.trim();
    const repoName = repoPath.split("/").pop()!;
    const parentDir = repoPath.replace(/\/[^/]+$/, "");
    return { repoPath, repoName, parentDir };
  } catch {
    return { parentDir: "", repoName: "", repoPath: "" };
  }
}

/** Discover oracles: union of fleet configs + running tmux sessions */
async function discoverOracles(): Promise<string[]> {
  const names = new Set<string>();

  // 1. Fleet configs (registered — includes sleeping)
  const fleetDir = FLEET_DIR;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.endsWith(".disabled"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      for (const w of config.windows || []) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* fleet dir may not exist */ }

  // 2. Running tmux (actual state — catches unregistered oracles)
  try {
    const sessions = await listSessions();
    for (const s of sessions) {
      for (const w of s.windows) {
        if (w.name.endsWith("-oracle")) names.add(w.name.replace(/-oracle$/, ""));
      }
    }
  } catch { /* tmux not running */ }

  return [...names].sort();
}

interface OracleStatus {
  name: string;
  session: string | null;
  windows: string[];
  worktrees: number;
  status: "awake" | "sleeping";
}

export async function cmdOracleAbout(oracle: string) {
  const name = oracle.toLowerCase();
  const sessions = await listSessions();

  console.log(`\n  \x1b[36mOracle — ${oracle.charAt(0).toUpperCase() + oracle.slice(1)}\x1b[0m\n`);

  // Repo
  const { repoPath, repoName, parentDir } = await resolveOracleSafe(name);
  console.log(`  Repo:      ${repoPath || "(not found)"}`);

  // Session + windows
  const session = await detectSession(name);
  if (session) {
    const s = sessions.find(s => s.name === session);
    const windows = s?.windows || [];
    console.log(`  Session:   ${session} (${windows.length} windows)`);
    for (const w of windows) {
      let status = "\x1b[90m○\x1b[0m";
      try {
        const content = await capture(`${session}:${w.index}`, 3);
        status = content.trim() ? "\x1b[32m●\x1b[0m" : "\x1b[33m●\x1b[0m";
      } catch { /* expected: capture may fail for inactive pane */ }
      console.log(`    ${status} ${w.name}`);
    }
  } else {
    console.log(`  Session:   (none)`);
  }

  // Worktrees
  if (parentDir) {
    const wts = await findWorktrees(parentDir, repoName);
    console.log(`  Worktrees: ${wts.length}`);
    for (const wt of wts) {
      console.log(`    ${wt.name} → ${wt.path}`);
    }
  }

  // Fleet config
  const fleetDir = FLEET_DIR;
  let fleetFile: string | null = null;
  let fleetWindowCount = 0;
  try {
    for (const file of readdirSync(fleetDir).filter(f => f.endsWith(".json"))) {
      const config = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
      const hasOracle = (config.windows || []).some(
        (w: any) => w.name.toLowerCase() === `${name}-oracle` || w.name.toLowerCase() === name
      );
      if (hasOracle) {
        fleetFile = file;
        fleetWindowCount = config.windows.length;
        break;
      }
    }
  } catch { /* expected: fleet dir may not exist */ }

  if (fleetFile) {
    const actualWindows = session
      ? (sessions.find(s => s.name === session)?.windows.length || 0)
      : 0;
    console.log(`  Fleet:     ${fleetFile} (${fleetWindowCount} registered, ${actualWindows} running)`);
    if (actualWindows > fleetWindowCount) {
      // Find which windows are unregistered
      const fleetConfig = JSON.parse(readFileSync(join(fleetDir, fleetFile), "utf-8"));
      const registeredNames = new Set((fleetConfig.windows || []).map((w: any) => w.name));
      const runningWindows = sessions.find(s => s.name === session)?.windows || [];
      const unregistered = runningWindows.filter(w => !registeredNames.has(w.name));

      console.log(`  \x1b[33m⚠\x1b[0m  ${unregistered.length} window(s) not in fleet config — won't survive reboot`);
      for (const w of unregistered) {
        console.log(`    \x1b[33m→\x1b[0m ${w.name}`);
      }
      console.log(`\n  \x1b[90mFix: add to fleet/${fleetFile}\x1b[0m`);
      console.log(`  \x1b[90m  maw fleet init          # regenerate all configs\x1b[0m`);
      console.log(`  \x1b[90m  maw fleet validate      # check for problems\x1b[0m`);
    }
  } else {
    console.log(`  Fleet:     (no config)`);
  }

  console.log();
}

export async function cmdOracleList() {
  const sessions = await listSessions();
  const statuses: OracleStatus[] = [];

  for (const oracle of await discoverOracles()) {
    const session = await detectSession(oracle);

    let windows: string[] = [];
    if (session) {
      const s = sessions.find(s => s.name === session);
      if (s) {
        windows = s.windows.map(w => w.name);
      }
    }

    // Count worktrees (resolveOracle may exit on failure, so catch that)
    let worktrees = 0;
    try {
      const { parentDir, repoName } = await resolveOracleSafe(oracle);
      if (parentDir) {
        const wts = await findWorktrees(parentDir, repoName);
        worktrees = wts.length;
      }
    } catch {
      // Oracle repo not found on this machine
    }

    statuses.push({
      name: oracle,
      session,
      windows,
      worktrees,
      status: session ? "awake" : "sleeping",
    });
  }

  // Sort: awake first, then alphabetical
  statuses.sort((a, b) => {
    if (a.status !== b.status) return a.status === "awake" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const awakeCount = statuses.filter(s => s.status === "awake").length;

  console.log(`\n  \x1b[36mOracle Fleet\x1b[0m  (${awakeCount}/${statuses.length} awake)\n`);
  console.log(`  ${"Oracle".padEnd(14)} ${"Status".padEnd(10)} ${"Session".padEnd(16)} ${"Windows".padEnd(6)} ${"WT".padEnd(4)} Details`);
  console.log(`  ${"─".repeat(80)}`);

  for (const s of statuses) {
    const icon = s.status === "awake" ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const statusText = s.status === "awake" ? "\x1b[32mawake\x1b[0m " : "\x1b[90msleep\x1b[0m ";
    const sessionText = s.session || "-";
    const winCount = s.windows.length > 0 ? String(s.windows.length) : "-";
    const wtCount = s.worktrees > 0 ? String(s.worktrees) : "-";
    const details = s.windows.length > 0
      ? s.windows.slice(0, 4).join(", ") + (s.windows.length > 4 ? ` +${s.windows.length - 4}` : "")
      : "";

    console.log(`  ${icon} ${s.name.padEnd(13)} ${statusText.padEnd(19)} ${sessionText.padEnd(16)} ${winCount.padEnd(6)} ${wtCount.padEnd(4)} ${details}`);
  }

  console.log();
}

// --- Fleet-wide scan + cache (#208) ---

export async function cmdOracleScan(opts: { force?: boolean; json?: boolean } = {}) {
  const start = Date.now();
  const cache = scanAndCache();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (opts.json) {
    console.log(JSON.stringify(cache, null, 2));
    return;
  }

  console.log(`\n  \x1b[32m✓\x1b[0m Scanned ${cache.oracles.length} oracles locally (${elapsed}s)\n`);
  console.log(`  Cache written to \x1b[90m~/.config/maw/oracles.json\x1b[0m`);
  console.log(`  Scanned at: ${cache.local_scanned_at}\n`);
}

export async function cmdOracleFleet(opts: { org?: string; stale?: boolean; json?: boolean } = {}) {
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

      console.log(`    ${icon} ${psiTag} ${o.name.padEnd(20)} ${lineage.padEnd(24)} ${node}${missing}`);
    }
    console.log();
  }

  if (total === 0) {
    console.log("  No oracles found. Run \x1b[90mmaw oracle scan\x1b[0m to refresh.\n");
  }
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
