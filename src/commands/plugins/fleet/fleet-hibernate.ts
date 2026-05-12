import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmux, FLEET_DIR } from "../../../sdk";
import { loadFleetEntries, type FleetEntry, type FleetSession } from "../../shared/fleet-load";

interface HibernateSnapshot {
  hibernated_at: string;
  panes: number;
  commands: string[];
  idle_duration?: string;
}

interface HibernatedFleetSession extends FleetSession {
  hibernated_at?: string;
  snapshot?: HibernateSnapshot;
}

function getSessionPanes(session: string): Array<{ cmd: string; idle: string }> {
  try {
    const raw = execSync(
      `tmux list-panes -t '${session}' -F '#{pane_current_command}|#{pane_idle_time}'`,
      { encoding: "utf8", timeout: 5000 },
    );
    return raw.trim().split("\n").filter(Boolean).map(line => {
      const [cmd, idle] = line.split("|");
      return { cmd: cmd || "unknown", idle: idle || "0" };
    });
  } catch { return []; }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function getProcessMemory(session: string): number {
  try {
    const raw = execSync(
      `tmux list-panes -t '${session}' -F '#{pane_pid}'`,
      { encoding: "utf8", timeout: 5000 },
    );
    const pids = raw.trim().split("\n").filter(Boolean);
    let totalKB = 0;
    for (const pid of pids) {
      try {
        const rss = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 3000 }).trim();
        totalKB += parseInt(rss, 10) || 0;
      } catch { /* process may have exited */ }
    }
    return totalKB;
  } catch { return 0; }
}

export async function cmdHibernate(args: string[]) {
  const isDryRun = args.includes("--dry-run");
  const keepList = args.find(a => a.startsWith("--keep="))?.split("=")[1]?.split(",") || [];
  const keepIdx = args.indexOf("--keep");
  if (keepIdx !== -1 && args[keepIdx + 1]) {
    keepList.push(...args[keepIdx + 1].split(","));
  }
  const targets = args.filter(a => !a.startsWith("--"));

  const entries = loadFleetEntries();
  let sessions: string[];
  try {
    sessions = (await tmux.listSessions()).map(s => s.name);
  } catch { sessions = []; }

  const currentSession = process.env.TMUX
    ? execSync("tmux display-message -p '#{session_name}'", { encoding: "utf8" }).trim()
    : "";

  // Determine which sessions to hibernate
  let toHibernate: string[];
  if (targets.length > 0) {
    toHibernate = sessions.filter(s => targets.some(t => s.includes(t)));
  } else {
    toHibernate = sessions;
  }

  // Exclude current session + --keep list
  toHibernate = toHibernate.filter(s => {
    if (s === currentSession) return false;
    return !keepList.some(k => s.includes(k));
  });

  if (toHibernate.length === 0) {
    console.log("  \x1b[90mnothing to hibernate\x1b[0m");
    return;
  }

  console.log(`\n  \x1b[36;1m💤 Hibernating ${toHibernate.length} session(s)\x1b[0m${isDryRun ? " \x1b[33m[dry-run]\x1b[0m" : ""}\n`);

  let count = 0;
  for (const sess of toHibernate) {
    const panes = getSessionPanes(sess);
    const maxIdle = Math.max(...panes.map(p => parseInt(p.idle, 10) || 0), 0);
    const memKB = getProcessMemory(sess);
    const memStr = memKB > 0 ? `${Math.round(memKB / 1024)}MB` : "?";

    // Find fleet config for this session
    const entry = entries.find(e => e.session.name === sess);

    if (isDryRun) {
      console.log(`  \x1b[90m[dry-run]\x1b[0m ${sess} (${panes.length} panes, idle ${formatDuration(maxIdle)}, ${memStr})`);
      continue;
    }

    // Save snapshot to fleet config
    if (entry) {
      const configPath = join(FLEET_DIR, entry.file);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.hibernated_at = new Date().toISOString();
      config.snapshot = {
        panes: panes.length,
        commands: panes.map(p => p.cmd),
        idle_duration: formatDuration(maxIdle),
      } satisfies HibernateSnapshot;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }

    // Kill session
    try {
      await tmux.killSession(sess);
      console.log(`  \x1b[90m💤\x1b[0m ${sess} (${panes.length} panes, idle ${formatDuration(maxIdle)}, freed ${memStr})`);
      count++;
    } catch {
      console.log(`  \x1b[31m✗\x1b[0m ${sess} — kill failed`);
    }
  }

  if (!isDryRun) {
    console.log(`\n  \x1b[32m${count} session(s) hibernated.\x1b[0m Resume: \x1b[36mmaw fleet resume\x1b[0m\n`);
  }
}

export async function cmdResume(args: string[]) {
  const isTest = args.includes("--test");
  const isAll = args.includes("--all");
  const targets = args.filter(a => !a.startsWith("--"));

  const entries = loadFleetEntries();
  const hibernated = entries.filter(e => (e.session as HibernatedFleetSession).hibernated_at);

  let toResume: FleetEntry[];
  if (targets.length > 0) {
    toResume = hibernated.filter(e => targets.some(t => e.groupName.includes(t) || e.session.name.includes(t)));
  } else if (isAll) {
    toResume = hibernated;
  } else {
    toResume = hibernated;
  }

  if (toResume.length === 0) {
    console.log("  \x1b[90mno hibernated sessions to resume\x1b[0m");
    return;
  }

  console.log(`\n  \x1b[36;1m⚡ Resuming ${toResume.length} session(s)\x1b[0m${isTest ? " \x1b[33m[test mode]\x1b[0m" : ""}\n`);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toResume.length; i++) {
    const entry = toResume[i];
    const oracleStem = entry.session.windows?.[0]?.name?.replace(/-oracle$/, "") || entry.groupName;
    const progress = `[${i + 1}/${toResume.length}]`;

    process.stdout.write(`  \x1b[90m⏳\x1b[0m ${progress} ${oracleStem}...`);

    try {
      execSync(`maw wake ${oracleStem}`, { timeout: 30000, stdio: "pipe" });

      if (isTest) {
        // Verify session exists
        await new Promise(r => setTimeout(r, 2000));
        const alive = await tmux.hasSession(entry.session.name).catch(() => false);
        if (alive) {
          console.log(` \x1b[32m✓ alive\x1b[0m`);
        } else {
          console.log(` \x1b[31m✗ not responding\x1b[0m`);
          failed++;
          continue;
        }
      } else {
        console.log(` \x1b[32m✓\x1b[0m`);
      }

      // Clear hibernate state from fleet config
      const configPath = join(FLEET_DIR, entry.file);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      delete config.hibernated_at;
      delete config.snapshot;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

      ok++;
    } catch (e: unknown) {
      console.log(` \x1b[31m✗ FAILED\x1b[0m: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      failed++;
    }
  }

  console.log(`\n  \x1b[32m${ok} resumed\x1b[0m${failed > 0 ? `, \x1b[31m${failed} failed\x1b[0m` : ""}\n`);
}

export async function cmdFleetStatus() {
  const entries = loadFleetEntries();
  let sessions: string[];
  try {
    sessions = (await tmux.listSessions()).map(s => s.name);
  } catch { sessions = []; }

  const running: Array<{ name: string; oracle: string; mem: string; panes: number }> = [];
  const hibernated: Array<{ name: string; oracle: string; since: string; snapshot?: HibernateSnapshot }> = [];
  const dead: Array<{ name: string; oracle: string }> = [];

  for (const entry of entries) {
    const sessName = entry.session.name;
    const oracle = entry.session.windows?.[0]?.name?.replace(/-oracle$/, "") || entry.groupName;

    if (sessions.includes(sessName)) {
      const memKB = getProcessMemory(sessName);
      const panes = getSessionPanes(sessName);
      running.push({
        name: sessName,
        oracle,
        mem: memKB > 0 ? `${Math.round(memKB / 1024)}MB` : "?",
        panes: panes.length,
      });
    } else if ((entry.session as HibernatedFleetSession).hibernated_at) {
      const since = (entry.session as HibernatedFleetSession).hibernated_at!;
      const ago = formatDuration(Math.floor((Date.now() - new Date(since).getTime()) / 1000));
      hibernated.push({ name: sessName, oracle, since: `${ago} ago`, snapshot: (entry.session as HibernatedFleetSession).snapshot });
    } else {
      dead.push({ name: sessName, oracle });
    }
  }

  // Also find sessions without fleet configs
  const fleetSessions = new Set(entries.map(e => e.session.name));
  const orphanSessions = sessions.filter(s => !fleetSessions.has(s));

  console.log(`\n  \x1b[36;1mFleet Status\x1b[0m\n`);
  console.log(`  ${"Oracle".padEnd(22)} ${"Session".padEnd(18)} ${"State".padEnd(14)} ${"Panes".padEnd(7)} Memory`);
  console.log(`  ${"─".repeat(22)} ${"─".repeat(18)} ${"─".repeat(14)} ${"─".repeat(7)} ${"─".repeat(8)}`);

  for (const r of running) {
    console.log(`  ${r.oracle.padEnd(22)} ${r.name.padEnd(18)} \x1b[32m🟢 running\x1b[0m     ${String(r.panes).padEnd(7)} ${r.mem}`);
  }
  for (const h of hibernated) {
    console.log(`  ${h.oracle.padEnd(22)} ${h.name.padEnd(18)} \x1b[33m💤 hibernated\x1b[0m  ${String(h.snapshot?.panes || "-").padEnd(7)} -`);
  }
  for (const d of dead) {
    console.log(`  ${d.oracle.padEnd(22)} ${d.name.padEnd(18)} \x1b[90m⚫ stopped\x1b[0m     -       -`);
  }
  for (const o of orphanSessions) {
    console.log(`  ${"\x1b[90m(no fleet)\x1b[0m".padEnd(33)} ${o.padEnd(18)} \x1b[33m⚠ orphan\x1b[0m      -       -`);
  }

  const totalMem = running.reduce((sum, r) => sum + parseInt(r.mem, 10) || 0, 0);
  console.log(`\n  \x1b[32m${running.length} running\x1b[0m (${totalMem > 0 ? totalMem + "MB" : "?"}) | \x1b[33m${hibernated.length} hibernated\x1b[0m | \x1b[90m${dead.length} stopped\x1b[0m${orphanSessions.length > 0 ? ` | \x1b[33m${orphanSessions.length} orphan\x1b[0m` : ""}\n`);
}
