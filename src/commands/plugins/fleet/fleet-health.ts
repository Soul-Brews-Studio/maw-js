import { listSessions, hostExec } from "../../../sdk";
import { loadFleetEntries } from "../../shared/fleet-load";
import { join } from "path";
import { getGhqRoot } from "../../../config/ghq-root";
import { FLEET_DIR } from "../../../sdk";
import { readdirSync as readDir } from "fs";

/**
 * maw fleet health — Cell cycle checkpoint.
 * Oracle-level health: activity, dormancy, zombies, islands, anti-patterns.
 */
export async function cmdFleetHealth() {
  const entries = loadFleetEntries();
  const sessions = await listSessions();
  const reposRoot = join(getGhqRoot(), "github.com");
  const now = Date.now();

  console.log(`\n  \x1b[36m🔬 Fleet Health\x1b[0m\n`);

  const rows: { name: string; status: string; age: string; peers: number; flag: string }[] = [];

  for (const entry of entries) {
    const oracleName = entry.session.name.replace(/^\d+-/, "");
    const sess = sessions.find(s => s.name.toLowerCase() === oracleName.toLowerCase() || s.name.toLowerCase() === entry.session.name.toLowerCase());
    const isAwake = !!sess;

    let lastActivity = "";
    let daysSinceActivity = -1;
    const mainWindow = entry.session.windows[0];
    if (mainWindow?.repo) {
      const repoPath = join(reposRoot,mainWindow.repo);
      try {
        const ts = await hostExec(`git -C '${repoPath}' log -1 --format='%ci' 2>/dev/null`);
        if (ts.trim()) {
          const d = new Date(ts.trim());
          daysSinceActivity = Math.floor((now - d.getTime()) / 86400000);
          lastActivity = daysSinceActivity === 0 ? "today" : daysSinceActivity === 1 ? "1d ago" : `${daysSinceActivity}d ago`;
        }
      } catch { lastActivity = "?"; }
    }

    const raw = entry.session as any;
    const buddedFrom = raw.budded_from || "";
    const peerCount = entry.session.sync_peers?.length || 0;

    const flags: string[] = [];
    if (daysSinceActivity > 90) flags.push("dormant");
    else if (daysSinceActivity > 30) flags.push("sleepy");
    if (peerCount === 0) flags.push("island");
    if (isAwake && daysSinceActivity > 14) flags.push("zombie?");
    if (buddedFrom) flags.push(`bud<-${buddedFrom}`);

    const status = isAwake ? "\x1b[32m●\x1b[0m awake" : "\x1b[90m○ sleep\x1b[0m";

    rows.push({
      name: oracleName,
      status,
      age: lastActivity || "—",
      peers: peerCount,
      flag: flags.join(" ") || "ok",
    });
  }

  rows.sort((a, b) => {
    const aAwake = a.status.includes("●") ? 0 : 1;
    const bAwake = b.status.includes("●") ? 0 : 1;
    return aAwake - bAwake || a.name.localeCompare(b.name);
  });

  const maxName = Math.max(...rows.map(r => r.name.length), 6);
  const maxAge = Math.max(...rows.map(r => r.age.length), 4);

  console.log(`  ${"Oracle".padEnd(maxName)}  Status       ${"Last".padEnd(maxAge)}  Peers  Health`);
  console.log(`  ${"─".repeat(maxName)}  ───────────  ${"─".repeat(maxAge)}  ─────  ──────`);

  for (const r of rows) {
    console.log(`  ${r.name.padEnd(maxName)}  ${r.status.padEnd(20)}  ${r.age.padEnd(maxAge)}  ${String(r.peers).padStart(3)}    ${r.flag}`);
  }

  const awake = rows.filter(r => r.status.includes("●")).length;
  const dormant = rows.filter(r => r.flag.includes("dormant")).length;
  const islands = rows.filter(r => r.flag.includes("island")).length;
  const zombies = rows.filter(r => r.flag.includes("zombie")).length;

  // Show disabled oracles with detail
  const disabledFiles = readDir(FLEET_DIR).filter((f: string) => f.endsWith(".disabled"));
  if (disabledFiles.length > 0) {
    console.log();
    console.log(`  \x1b[90m── Disabled (${disabledFiles.length}) ──\x1b[0m`);
    for (const f of disabledFiles) {
      try {
        const cfg = JSON.parse(require("fs").readFileSync(join(FLEET_DIR, f), "utf-8"));
        const dName = f.replace(/^\d+-/, "").replace(".json.disabled", "");
        const num = f.match(/^(\d+)/)?.[1] || "?";
        const wins = cfg.windows?.length || 0;
        const repo = cfg.windows?.[0]?.repo || "?";
        const peers = cfg.sync_peers?.length || 0;
        const repoExists = require("fs").existsSync(join(reposRoot,repo));
        console.log(`  \x1b[90m  ${num.padStart(2)}  ${dName.padEnd(20)} ${String(wins).padStart(2)} win  repo:${repoExists ? "yes" : "no "}  peers:${peers}\x1b[0m`);
      } catch {
        const dName = f.replace(/^\d+-/, "").replace(".json.disabled", "");
        console.log(`  \x1b[90m  ✕ ${dName}\x1b[0m`);
      }
    }
  }

  console.log();
  console.log(`  \x1b[90m${rows.length} active | ${awake} awake | ${disabledFiles.length} disabled | ${dormant} dormant | ${islands} islands | ${zombies} zombies\x1b[0m`);
  if (dormant > 0) console.log(`  \x1b[33m⚠\x1b[0m ${dormant} inactive >90d — consider: maw archive <name>`);
  if (islands > 0) console.log(`  \x1b[33m⚠\x1b[0m ${islands} have zero sync_peers — knowledge trapped`);
  if (zombies > 0) console.log(`  \x1b[33m⚠\x1b[0m ${zombies} awake but inactive >14d — zombie?`);
  console.log();
}
