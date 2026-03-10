import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { ssh } from "./ssh";

interface FleetWindow {
  name: string;
  repo: string;
}

interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
}

// Default grouping: oracle name → session group
const GROUPS: Record<string, { session: string; order: number }> = {
  homekeeper: { session: "oracles", order: 1 },
  nexus: { session: "oracles", order: 1 },
  arthur: { session: "arra", order: 2 },
  dustboy: { session: "arra", order: 2 },
  floodboy: { session: "arra", order: 2 },
  fireman: { session: "arra", order: 2 },
  xiaoer: { session: "brewing", order: 3 },
  maeon: { session: "brewing", order: 3 },
  mother: { session: "watchers", order: 4 },
  landing: { session: "watchers", order: 4 },
  odin: { session: "watchers", order: 4 },
  volt: { session: "solar", order: 6 },
  hermes: { session: "hermes", order: 7 },
  neo: { session: "neo", order: 8 },
  pulse: { session: "pulse", order: 9 },
  calliope: { session: "calliope", order: 10 },
};

export async function cmdFleetInit() {
  const fleetDir = join(import.meta.dir, "../fleet");
  if (!existsSync(fleetDir)) mkdirSync(fleetDir, { recursive: true });

  // Scan ghq for oracle repos
  console.log(`\n  \x1b[36mScanning for oracle repos...\x1b[0m\n`);

  const ghqOut = await ssh("ghq list --full-path");
  const allRepos = ghqOut.trim().split("\n").filter(Boolean);

  // Find oracle repos
  const oracleRepos: { name: string; path: string; repo: string; worktrees: { name: string; path: string; repo: string }[] }[] = [];

  for (const repoPath of allRepos) {
    const parts = repoPath.split("/");
    const repoName = parts.pop()!;
    const org = parts.pop()!;
    const parentDir = parts.join("/") + "/" + org;

    // Match *-oracle repos or known names
    let oracleName: string | null = null;
    if (repoName.endsWith("-oracle")) {
      oracleName = repoName.replace(/-oracle$/, "").replace(/-/g, "");
    } else if (repoName === "homelab") {
      oracleName = "homekeeper";
    }

    if (!oracleName) continue;
    // Skip worktree dirs (they have .wt- in the name)
    if (repoName.includes(".wt-")) continue;

    // Find worktrees
    const worktrees: { name: string; path: string; repo: string }[] = [];
    try {
      const wtOut = await ssh(`ls -d ${parentDir}/${repoName}.wt-* 2>/dev/null || true`);
      for (const wtPath of wtOut.split("\n").filter(Boolean)) {
        const wtBase = wtPath.split("/").pop()!;
        const suffix = wtBase.replace(`${repoName}.wt-`, "");
        worktrees.push({
          name: `${oracleName}-${suffix}`,
          path: wtPath,
          repo: `${org}/${wtBase}`,
        });
      }
    } catch { /* no worktrees */ }

    oracleRepos.push({
      name: oracleName,
      path: repoPath,
      repo: `${org}/${repoName}`,
      worktrees,
    });

    const wtInfo = worktrees.length > 0 ? ` + ${worktrees.length} worktrees` : "";
    console.log(`  found: ${oracleName.padEnd(15)} ${org}/${repoName}${wtInfo}`);
  }

  // Group into sessions
  const sessionMap = new Map<string, { order: number; windows: FleetWindow[] }>();

  for (const oracle of oracleRepos) {
    const group = GROUPS[oracle.name] || { session: oracle.name, order: 50 };
    const key = group.session;

    if (!sessionMap.has(key)) {
      sessionMap.set(key, { order: group.order, windows: [] });
    }

    const sess = sessionMap.get(key)!;
    sess.windows.push({ name: `${oracle.name}-oracle`, repo: oracle.repo });

    for (const wt of oracle.worktrees) {
      sess.windows.push({ name: wt.name, repo: wt.repo });
    }
  }

  // Write fleet files
  console.log(`\n  \x1b[36mWriting fleet configs...\x1b[0m\n`);

  const sorted = [...sessionMap.entries()].sort((a, b) => a[1].order - b[1].order);
  let num = 1;

  for (const [groupName, data] of sorted) {
    const paddedNum = String(num).padStart(2, "0");
    const sessionName = `${paddedNum}-${groupName}`;
    const config: FleetSession = { name: sessionName, windows: data.windows };
    const filePath = join(fleetDir, `${sessionName}.json`);

    await Bun.write(filePath, JSON.stringify(config, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m ${sessionName}.json — ${data.windows.length} windows`);
    num++;
  }

  // Add overview session
  if (oracleRepos.length > 0) {
    const overviewConfig: FleetSession = {
      name: "99-overview",
      windows: [{ name: "live", repo: oracleRepos[0].repo }],
      skip_command: true,
    };
    await Bun.write(join(fleetDir, "99-overview.json"), JSON.stringify(overviewConfig, null, 2) + "\n");
    console.log(`  \x1b[32m✓\x1b[0m 99-overview.json — 1 window`);
  }

  console.log(`\n  \x1b[32m${sorted.length + 1} fleet configs written to fleet/\x1b[0m`);
  console.log(`  Run \x1b[36mmaw wake all\x1b[0m to start the fleet.\n`);
}
